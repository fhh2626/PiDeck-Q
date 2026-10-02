/** Cross-source identity pairing. Text/time alone never identifies a PC user turn. */
import type { UIMessage } from "ai";
import { readWebMessageMetadata, uiMessageIdentity, uiMessageRole, type WebMessageMetadata } from "./webMessageMetadata";

import { webMessageContentKey as contentKey } from "./webMessageParts";

type Turn = { user: number; replies: number[]; evidence: Set<string> };
const MAX_MESSAGE_ALIASES = 8;

/** Build evidence only inside a user-anchored turn, never from a page's leading replies. */
function turns(messages: UIMessage[]): Turn[] {
	const result: Turn[] = [];
	let active: Turn | undefined;
	messages.forEach((message, index) => {
		if (uiMessageRole(message) === "user") {
			active = { user: index, replies: [], evidence: new Set() };
			result.push(active);
		} else if (active) {
			active.replies.push(index);
			active.evidence.add(`id:${message.id}`);
			const identity = uiMessageIdentity(message);
			if (identity) active.evidence.add(identity);
			for (const part of message.parts) {
				if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) continue;
				const id: unknown = Reflect.get(part, "toolCallId");
				if (typeof id === "string" && id) active.evidence.add(`tool:${id}`);
			}
		}
	});
	return result;
}

function evidenceCounts(rows: Turn[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) for (const key of row.evidence) counts.set(key, (counts.get(key) ?? 0) + 1);
	return counts;
}

function conflictingEntries(a: UIMessage, b: UIMessage): boolean {
	const left = readWebMessageMetadata(a)?.entryId;
	const right = readWebMessageMetadata(b)?.entryId;
	return Boolean(left && right && left !== right);
}

function knownIds(message: UIMessage): string[] {
	return [message.id, ...(readWebMessageMetadata(message)?.reconciledIds ?? [])];
}

/** Preserve both source ids and the Pi entry so later polls/pages cannot recreate the duplicate. */
function pairedMessages(left: UIMessage, right: UIMessage): [UIMessage, UIMessage] {
	const leftMetadata = readWebMessageMetadata(left);
	const rightMetadata = readWebMessageMetadata(right);
	// Web's optimistic user has no metadata. It may inherit the proven Pi identity,
	// but unidentifiable assistant bubbles must never gain an entry by text alone.
	if ((!leftMetadata && uiMessageRole(left) !== "user")
		|| (!rightMetadata && uiMessageRole(right) !== "user")) return [left, right];
	const a: WebMessageMetadata = leftMetadata ?? { chatRole: "user" };
	const b: WebMessageMetadata = rightMetadata ?? { chatRole: "user" };
	const metadata = {
		...a, ...b,
		// Pi entry metadata is canonical, regardless of which source arrived first.
		...(a.entryId && !b.entryId ? a : {}),
		reconciledIds: [...new Set([...knownIds(left), ...knownIds(right)])].slice(-MAX_MESSAGE_ALIASES),
	};
	const canonicalId = a.entryId && !b.entryId ? left.id : right.id;
	const update = (message: UIMessage): UIMessage => message.id === canonicalId
		&& JSON.stringify(message.metadata) === JSON.stringify(metadata)
		? message : { ...message, id: canonicalId, metadata };
	return [update(left), update(right)];
}

/** Only Pi-backed reply rows can acquire aliases; unidentified SSE bubbles remain separate. */
function isPairableReply(message: UIMessage): boolean {
	return uiMessageRole(message) === "assistant"
		&& readWebMessageMetadata(message) !== undefined
		&& message.parts.length > 0;
}

/** Pair persisted reply rows only after their user turns are proven identical. */
function pairReplies(
	left: UIMessage[], right: UIMessage[], a: Turn, b: Turn,
	leftUpdates: Map<number, UIMessage>, rightUpdates: Map<number, UIMessage>,
): void {
	const eligible = isPairableReply;
	for (const index of a.replies) {
		const message = left[index];
		if (!eligible(message)) continue;
		const key = contentKey(message);
		const sourceMatches = a.replies.filter((i) => eligible(left[i]) && contentKey(left[i]) === key);
		const targetMatches = b.replies.filter((i) => eligible(right[i]) && contentKey(right[i]) === key);
		// Repeated same-text replies within one tool loop remain ambiguous; no reverse-order guess.
		if (sourceMatches.length !== 1 || targetMatches.length !== 1) continue;
		const target = targetMatches[0];
		if (conflictingEntries(message, right[target])) continue;
		const [current, incoming] = pairedMessages(message, right[target]);
		leftUpdates.set(index, current);
		rightUpdates.set(target, incoming);
	}
}

/** Replay proven user/reply aliases so stale useChat arrays cannot resurrect either copy. */
function applyKnownMessageAliases(rows: UIMessage[], evidence: UIMessage[]): UIMessage[] {
	const byId = new Map<string, UIMessage>();
	const ambiguous = new Set<string>();
	for (const message of evidence) {
		if (uiMessageRole(message) !== "user" && !isPairableReply(message)) continue;
		const metadata = readWebMessageMetadata(message);
		if (!metadata?.entryId || !metadata.reconciledIds?.length) continue;
		for (const id of knownIds(message)) {
			const previous = byId.get(id);
			if (previous && (conflictingEntries(previous, message) || uiMessageRole(previous) !== uiMessageRole(message))) ambiguous.add(id);
			else if (!previous) byId.set(id, message);
		}
	}
	let changed = false;
	const seen = new Set<string>();
	const result: UIMessage[] = [];
	for (const message of rows) {
		const canonical = !ambiguous.has(message.id) ? byId.get(message.id) : undefined;
		if (!canonical || uiMessageRole(message) !== uiMessageRole(canonical)
			|| conflictingEntries(message, canonical) || contentKey(message) !== contentKey(canonical)) {
			result.push(message);
			continue;
		}
		if (seen.has(canonical.id)) { changed = true; continue; }
		seen.add(canonical.id);
		const metadata = readWebMessageMetadata(canonical);
		const same = message.id === canonical.id && JSON.stringify(message.metadata) === JSON.stringify(metadata);
		changed ||= !same;
		result.push(same ? message : { ...message, id: canonical.id, metadata });
	}
	return changed ? result : rows;
}

/**
 * Heal reply copies using the third snapshot BEFORE collapsing the duplicate user anchors.
 * Earlier timestamp insertion can already have put both replies under the persisted user.
 * Require one directly named live reply plus one compatible Pi entry and a unique incoming
 * reply; three copies or repeated same-text replies in the snapshot remain ambiguous.
 */
function healBridgedReplies(
	current: UIMessage[], incoming: UIMessage[], sources: number[], target: Turn,
	updates: Map<number, UIMessage>, incomingUpdates: Map<number, UIMessage>, removed: Set<number>,
): void {
	for (const index of target.replies) {
		const reply = incoming[index];
		if (!isPairableReply(reply)) continue;
		const key = contentKey(reply);
		const matches = sources.filter((i) => isPairableReply(current[i]) && contentKey(current[i]) === key);
		const targets = target.replies.filter((i) => isPairableReply(incoming[i]) && contentKey(incoming[i]) === key);
		if (matches.length !== 2 || targets.length !== 1) continue;
		const named = matches.filter((i) => knownIds(current[i]).some((id) => knownIds(reply).includes(id)));
		if (named.length !== 1) continue;
		const persisted = matches.find((i) => i !== named[0] && readWebMessageMetadata(current[i])?.entryId);
		if (persisted === undefined || conflictingEntries(current[persisted], reply)
			|| conflictingEntries(current[named[0]], current[persisted])) continue;
		if (matches.some((i) => updates.has(i) || removed.has(i))) continue;
		const [, canonical] = pairedMessages(current[persisted], reply);
		const [, joined] = pairedMessages(current[named[0]], canonical);
		updates.set(Math.min(...matches), joined);
		removed.add(Math.max(...matches));
		incomingUpdates.set(index, joined);
	}
}

/**
 * A third snapshot can prove two cached users are copies: it names the live UUID
 * and shares a unique tool with the persisted turn. Neither text nor time suffices.
 * This heals early user-only races once Pi has emitted the identifying reply/tool.
 */
function healBridgedUsers(current: UIMessage[], incoming: UIMessage[]): { current: UIMessage[]; incoming: UIMessage[] } {
	const left = turns(current);
	const right = turns(incoming);
	const leftCounts = evidenceCounts(left);
	const rightCounts = evidenceCounts(right);
	const updates = new Map<number, UIMessage>();
	const incomingUpdates = new Map<number, UIMessage>();
	const removed = new Set<number>();
	for (const target of right) {
		const user = incoming[target.user];
		if (!readWebMessageMetadata(user)) continue;
		const live = left.filter((turn) => !readWebMessageMetadata(current[turn.user])?.entryId
			&& !readWebMessageMetadata(current[turn.user])?.streamingBehavior
			&& knownIds(current[turn.user]).some((id) => knownIds(user).includes(id)));
		if (live.length !== 1) continue;
		const persisted = left.filter((turn) => turn !== live[0]
			&& readWebMessageMetadata(current[turn.user])?.entryId
			&& !conflictingEntries(current[turn.user], user)
			&& contentKey(current[turn.user]) === contentKey(user)
			&& [...turn.evidence].some((key) => target.evidence.has(key)
				&& rightCounts.get(key) === 1
				// Old buggy caches may already repeat the same tool beneath BOTH copies.
				// Only the directly named live user and this persisted user may own it.
				&& (leftCounts.get(key) === 1 || left.every((owner) =>
					!owner.evidence.has(key) || owner === live[0] || owner === turn))));
		if (persisted.length !== 1 || contentKey(current[live[0].user]) !== contentKey(user)) continue;
		const a = live[0].user;
		const b = persisted[0].user;
		if (updates.has(a) || updates.has(b) || removed.has(a) || removed.has(b)) continue;
		const [, canonical] = pairedMessages(current[b], user);
		const [, joined] = pairedMessages(current[a], canonical);
		// Keep the earliest user position so all cached replies stay behind their anchor.
		updates.set(Math.min(a, b), joined);
		removed.add(Math.max(a, b));
		incomingUpdates.set(target.user, joined);
		healBridgedReplies(current, incoming, [...live[0].replies, ...persisted[0].replies], target,
			updates, incomingUpdates, removed);
	}
	return {
		current: updates.size ? current.flatMap((row, index) => removed.has(index) ? [] : [updates.get(index) ?? row]) : current,
		incoming: incomingUpdates.size ? incoming.map((row, index) => incomingUpdates.get(index) ?? row) : incoming,
	};
}

/** Resolve one-to-one turn identities, retaining input references when nothing changes. */
export function reconcileWebMessageIdentities(current: UIMessage[], incoming: UIMessage[]): {
	current: UIMessage[]; incoming: UIMessage[];
} {
	const evidence = [...current, ...incoming];
	current = applyKnownMessageAliases(current, evidence);
	incoming = applyKnownMessageAliases(incoming, evidence);
	const healed = healBridgedUsers(current, incoming);
	current = healed.current;
	incoming = healed.incoming;
	const leftTurns = turns(current);
	const rightTurns = turns(incoming);
	const leftCounts = evidenceCounts(leftTurns);
	const rightCounts = evidenceCounts(rightTurns);
	const candidates = leftTurns.map((a) => rightTurns.filter((b) => {
		const left = current[a.user];
		const right = incoming[b.user];
		const aMetadata = readWebMessageMetadata(left);
		const bMetadata = readWebMessageMetadata(right);
		if ((!aMetadata && !bMetadata) || conflictingEntries(left, right)) return false;
		const identity = uiMessageIdentity(left);
		const aliased = Boolean(aMetadata?.reconciledIds?.length || bMetadata?.reconciledIds?.length);
		// Existing exact-id/entry matching keeps its established incoming-row semantics.
		// Only a previously proven bridge needs aliases replayed before the normal merge.
		if (knownIds(left).some((id) => knownIds(right).includes(id))
			|| (identity && identity === uiMessageIdentity(right))) return aliased;
		if (aMetadata?.entryId && bMetadata?.entryId) return false;
		// A steer/follow-up bubble can be ahead of the previous turn's tools.
		// Wait for stable identity instead of assigning those tools to the queued prompt.
		if (aMetadata?.streamingBehavior || bMetadata?.streamingBehavior) return false;
		// Check small identity sets before serializing potentially large image attachments.
		const provenTurn = [...a.evidence].some((key) => b.evidence.has(key)
			&& leftCounts.get(key) === 1 && rightCounts.get(key) === 1);
		return provenTurn && contentKey(left) === contentKey(right);
	}));
	const leftUpdates = new Map<number, UIMessage>();
	const rightUpdates = new Map<number, UIMessage>();
	leftTurns.forEach((a, index) => {
		if (candidates[index].length !== 1) return;
		const b = candidates[index][0];
		if (candidates.filter((matches) => matches.includes(b)).length !== 1) return;
		const [left, right] = pairedMessages(current[a.user], incoming[b.user]);
		leftUpdates.set(a.user, left);
		rightUpdates.set(b.user, right);
		pairReplies(current, incoming, a, b, leftUpdates, rightUpdates);
	});
	const apply = (rows: UIMessage[], updates: Map<number, UIMessage>) => {
		if (![...updates].some(([index, value]) => rows[index] !== value)) return rows;
		return rows.map((row, index) => updates.get(index) ?? row);
	};
	const currentRows = apply(current, leftUpdates);
	const incomingRows = apply(incoming, rightUpdates);
	// A proven live user/reply can already coexist with its canonical disk copy.
	// Replay newly established aliases immediately, before normal merge/coverage sees
	// two identical user anchors and incorrectly treats their reply ownership as ambiguous.
	const joinedEvidence = [...currentRows, ...incomingRows];
	return {
		current: applyKnownMessageAliases(currentRows, joinedEvidence),
		incoming: applyKnownMessageAliases(incomingRows, joinedEvidence),
	};
}
