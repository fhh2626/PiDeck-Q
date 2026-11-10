/**
 * Evidence collection for the subagent recovery brief.
 *
 * The brief must let the parent judge the WHOLE task, so the history is built
 * from every execution phase rather than the last few messages. Two sections
 * are produced on purpose:
 *   - `executionHistory`: phase-bucketed, budgeted coverage of the run,
 *   - `recentToolCalls`: the tail of tool activity that explains the
 *     interruption point.
 *
 * Rules kept here (and pinned by tests):
 *   - thinking blocks are never included; only observable text and tool data,
 *   - every dropped region is marked, so the model cannot read a partial
 *     record as a complete one,
 *   - the output stays inside a fixed character budget.
 */

import type { RecoveryBriefPromptSections } from "./recovery-brief-prompt.ts";

/** Total character budget for the phase-bucketed history section. */
export const RECOVERY_BRIEF_HISTORY_BUDGET_CHARS = 12_000;
/** Number of contiguous execution phases the history must span. */
export const RECOVERY_BRIEF_PHASE_COUNT = 6;
/** Recent tool calls reported separately from the history. */
export const RECOVERY_BRIEF_RECENT_TOOL_LIMIT = 6;
/** Per-entry caps keep one giant message from consuming a whole phase. */
const MAX_TEXT_CHARS = 600;
const MAX_TOOL_ARGS_CHARS = 160;
const MAX_TOOL_RESULT_CHARS = 320;
const MAX_TOOL_NAME_CHARS = 64;

/** Loose structural view of a pi message; avoids a runtime pi dependency here. */
export interface RecoveryBriefMessage {
	role?: unknown;
	content?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	isError?: unknown;
	provider?: unknown;
	model?: unknown;
	thinkingLevel?: unknown;
}

export interface RecoveryBriefRecentTool {
	tool?: unknown;
	args?: unknown;
	endMs?: unknown;
}

export interface RecoveryBriefEvidenceInput {
	task: string;
	agent?: string;
	error?: string;
	exitCode: number;
	timedOut?: boolean;
	model?: string;
	thinking?: string;
	messages?: readonly RecoveryBriefMessage[];
	/** Existing child history before this run, including its task requests. */
	priorMessages?: readonly RecoveryBriefMessage[];
	recentTools?: readonly RecoveryBriefRecentTool[];
	progressSummary?: { toolCount?: number; tokens?: number; durationMs?: number };
	attemptedModels?: readonly string[];
	sessionFile?: string;
	transcriptPath?: string;
	artifactPaths?: { outputPath?: string; metadataPath?: string; transcriptPath?: string };
}

export interface RecoveryBriefEvidence extends RecoveryBriefPromptSections {
	/** Execution phases the history actually covers. */
	coveredPhases: number;
	/** True when any evidence was dropped or clipped. */
	truncated: boolean;
}

type TimelineEntry =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; args: string; id?: string }
	| { kind: "result"; name: string; text: string; isError: boolean; id?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function clip(value: string, limit: number, preserveTail = false): { text: string; clipped: boolean } {
	const collapsed = value.replace(/\r\n/g, "\n").trim();
	if (collapsed.length <= limit) return { text: collapsed, clipped: false };
	// Validation commands usually report their outcome at the end of a long log.
	if (preserveTail) {
		const marker = "… [clipped] …";
		const retained = Math.max(0, limit - marker.length);
		const head = Math.ceil(retained / 2);
		const tail = Math.floor(retained / 2);
		return { text: `${collapsed.slice(0, head)}${marker}${collapsed.slice(-tail)}`, clipped: true };
	}
	return { text: `${collapsed.slice(0, limit)}… [clipped]`, clipped: true };
}

function toolNameOf(message: RecoveryBriefMessage, part: Record<string, unknown> | undefined): string {
	const raw = part?.name ?? message.toolName;
	const name = typeof raw === "string" ? raw.trim() : "";
	return clip(name || "tool", MAX_TOOL_NAME_CHARS).text;
}

/**
 * Flatten message content into plain text.
 *
 * Kept local instead of reusing `shared/utils.ts`: that module pulls in the
 * settings/agent discovery graph, which the evidence builder must not depend on
 * (it also runs in tests without the pi runtime).
 */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const rawPart of content) {
		const part = asRecord(rawPart);
		if (!part) continue;
		// Only observable text is evidence; `thinking` parts are skipped here and
		// again in buildTimeline so a nested shape cannot leak them.
		if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
		else if (part.type === "tool_result") texts.push(contentToText(part.content));
	}
	return texts.filter((text) => text.trim().length > 0).join("\n");
}

/** Ordered preview of the arguments that identify a tool call. */
const TOOL_ARG_PREVIEW_KEYS = ["path", "file_path", "command", "query", "pattern", "url", "tool", "agent", "task", "key"] as const;

function toolArgsPreview(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const parts: string[] = [];
	for (const key of TOOL_ARG_PREVIEW_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			parts.push(value.trim());
			break;
		}
	}
	if (parts.length === 0) {
		for (const value of Object.values(args)) {
			if (typeof value === "string" && value.trim()) {
				parts.push(value.trim());
				break;
			}
		}
	}
	return parts.join(" ").replace(/\s+/g, " ");
}

/**
 * Flatten a message list into ordered timeline entries.
 * Assistant text and tool calls are kept; tool results are kept with their
 * error flag. Thinking parts and every other part type are dropped.
 */
function buildTimeline(messages: readonly RecoveryBriefMessage[] | undefined, includeRequests = false): { entries: TimelineEntry[]; clipped: boolean } {
	const entries: TimelineEntry[] = [];
	let clipped = false;
	for (const message of messages ?? []) {
		if (!message || typeof message !== "object") continue;
		const role = typeof message.role === "string" ? message.role : "";
		if (role === "user" && includeRequests) {
			const request = clip(contentToText(message.content), 2_000);
			clipped = clipped || request.clipped;
			if (request.text) entries.push({ kind: "text", text: `[stored task request] ${request.text}` });
			continue;
		}
		if (role === "toolResult") {
			const result = clip(contentToText(message.content), MAX_TOOL_RESULT_CHARS, true);
			clipped = clipped || result.clipped;
			if (!result.text) continue;
			entries.push({
				kind: "result",
				name: toolNameOf(message, undefined),
				text: result.text,
				isError: message.isError === true,
				...(typeof message.toolCallId === "string" ? { id: message.toolCallId } : {}),
			});
			continue;
		}
		if (role !== "assistant") continue;
		const parts = Array.isArray(message.content) ? message.content : [];
		for (const rawPart of parts) {
			const part = asRecord(rawPart);
			if (!part) continue;
			if (part.type === "text") {
				const text = clip(typeof part.text === "string" ? part.text : "", MAX_TEXT_CHARS);
				clipped = clipped || text.clipped;
				if (text.text) entries.push({ kind: "text", text: text.text });
				continue;
			}
			if (part.type === "toolCall") {
				const args = clip(toolArgsPreview(asRecord(part.arguments)), MAX_TOOL_ARGS_CHARS);
				clipped = clipped || args.clipped;
				entries.push({
					kind: "tool", name: toolNameOf(message, part), args: args.text,
					...(typeof part.id === "string" ? { id: part.id } : {}),
				});
			}
			// `thinking` and any other part type are intentionally not evidence.
		}
	}
	return { entries, clipped };
}

function renderEntry(entry: TimelineEntry): string {
	if (entry.kind === "text") return entry.text;
	if (entry.kind === "tool") return `[tool] ${entry.name}${entry.args ? `(${entry.args})` : ""}`;
	return `[${entry.isError ? "tool-error" : "tool-result"}] ${entry.name}: ${entry.text}`;
}

/**
 * Render the timeline into `phaseCount` contiguous buckets, each with its own
 * character allowance. Bucketing is what keeps early and middle work visible:
 * a plain head/tail slice would drop exactly the middle the parent needs.
 */
function renderPhasedHistory(
	entries: readonly TimelineEntry[],
	phaseCount: number,
	budgetChars: number,
): { text: string; coveredPhases: number; truncated: boolean } {
	if (entries.length === 0) return { text: "(no execution records were captured)", coveredPhases: 0, truncated: false };
	const phases = Math.max(1, Math.min(phaseCount, entries.length));
	const perPhaseBudget = Math.max(200, Math.floor(budgetChars / phases));
	const sections: string[] = [];
	let truncated = false;

	for (let phase = 0; phase < phases; phase++) {
		const start = Math.floor((phase * entries.length) / phases);
		const end = Math.floor(((phase + 1) * entries.length) / phases);
		const slice = entries.slice(start, end);
		const lines: string[] = [];
		let used = 0;
		let rendered = 0;
		for (const entry of slice) {
			const line = renderEntry(entry);
			if (used + line.length + 1 > perPhaseBudget) break;
			lines.push(line);
			used += line.length + 1;
			rendered += 1;
		}
		const dropped = slice.length - rendered;
		if (dropped > 0) {
			// Always keep the phase's newest record: that is the interruption
			// point the parent needs, and a start-only window would hide it.
			// The tail record is re-appended, so it is NOT omitted: counting it as
			// dropped would print an omission marker (and the "clipped or omitted"
			// note) for a phase that lost nothing.
			const last = slice[slice.length - 1];
			const lastLine = last ? renderEntry(last) : "";
			const omitted = lastLine ? dropped - 1 : dropped;
			if (omitted > 0) {
				truncated = true;
				lines.push(`[... ${omitted} record(s) omitted from this phase ...]`);
			}
			if (lastLine) lines.push(lastLine);
		}
		sections.push(`--- phase ${phase + 1}/${phases} ---\n${lines.join("\n")}`);
	}

	return { text: sections.join("\n\n"), coveredPhases: phases, truncated };
}

function renderRecentTools(
	recentTools: readonly RecoveryBriefRecentTool[] | undefined,
	entries: readonly TimelineEntry[],
): string {
	// Pair by call id so parallel tools with the same name keep their own results.
	// Progress previews are a fallback when no message-level calls were captured.
	type ToolRow = { call: Extract<TimelineEntry, { kind: "tool" }>; result?: Extract<TimelineEntry, { kind: "result" }> };
	const calls: ToolRow[] = [];
	const byId = new Map<string, ToolRow>();
	for (const entry of entries) {
		if (entry.kind === "tool") {
			const row: ToolRow = { call: entry };
			calls.push(row);
			if (entry.id) byId.set(entry.id, row);
		} else if (entry.kind === "result") {
			const row = entry.id ? byId.get(entry.id) : calls.findLast((item) => item.call.name === entry.name && !item.result);
			if (row) row.result = entry;
		}
	}
	if (calls.length > 0) {
		return calls.slice(-RECOVERY_BRIEF_RECENT_TOOL_LIMIT).map(({ call, result }) =>
			`- ${renderEntry(call)} → ${result ? renderEntry(result).replace(/\s+/g, " ") : "result unconfirmed"}`,
		).join("\n");
	}
	const rows = (recentTools ?? [])
		.slice(-RECOVERY_BRIEF_RECENT_TOOL_LIMIT)
		.map((tool) => {
			const name = clip(typeof tool.tool === "string" ? tool.tool : "tool", MAX_TOOL_NAME_CHARS).text;
			const args = clip(typeof tool.args === "string" ? tool.args : "", MAX_TOOL_ARGS_CHARS).text;
			return `- ${name}${args ? `(${args})` : ""}`;
		});
	return rows.length > 0 ? rows.join("\n") : "(no tool activity was recorded)";
}

function renderReferences(input: RecoveryBriefEvidenceInput): string {
	const rows: string[] = [];
	if (input.agent) rows.push(`- Agent: ${input.agent}`);
	if (input.model) rows.push(`- Model: ${input.model}`);
	if (input.thinking) rows.push(`- Thinking level: ${input.thinking}`);
	if (input.sessionFile) rows.push(`- Child session file: ${input.sessionFile}`);
	if (input.transcriptPath) rows.push(`- Child transcript: ${input.transcriptPath}`);
	if (input.artifactPaths?.outputPath) rows.push(`- Output artifact: ${input.artifactPaths.outputPath}`);
	if (input.artifactPaths?.metadataPath) rows.push(`- Metadata artifact: ${input.artifactPaths.metadataPath}`);
	return rows.length > 0 ? rows.join("\n") : "(no persisted references were recorded)";
}

function renderTermination(input: RecoveryBriefEvidenceInput): string {
	const rows: string[] = [`- Exit code: ${input.exitCode}`];
	if (input.timedOut) rows.push("- The run hit its elapsed timeout.");
	if (input.error) rows.push(`- Reported error: ${clip(input.error, 2_000).text}`);
	if (input.attemptedModels && input.attemptedModels.length > 1) {
		rows.push(`- Attempted models: ${input.attemptedModels.join(", ")}`);
	}
	const summary = input.progressSummary;
	if (summary) {
		const parts: string[] = [];
		if (typeof summary.toolCount === "number") parts.push(`${summary.toolCount} tool call(s)`);
		if (typeof summary.tokens === "number") parts.push(`${summary.tokens} token(s)`);
		if (typeof summary.durationMs === "number") parts.push(`${Math.round(summary.durationMs / 1000)}s elapsed`);
		if (parts.length > 0) rows.push(`- Recorded activity: ${parts.join(", ")}`);
	}
	return rows.join("\n");
}

/** Build the bounded, phase-spanning evidence handed to the brief inference. */
export function buildRecoveryBriefEvidence(input: RecoveryBriefEvidenceInput): RecoveryBriefEvidence {
	const timeline = buildTimeline(input.messages);
	const prior = buildTimeline(input.priorMessages, true);
	// Stored context and this run get separate budgets so neither can crowd out
	// the other. Keeping task requests lets a resumed brief recover the objective.
	const priorBudget = prior.entries.length > 0 ? 4_000 : 0;
	const priorHistory = renderPhasedHistory(prior.entries, RECOVERY_BRIEF_PHASE_COUNT, priorBudget);
	const history = renderPhasedHistory(timeline.entries, RECOVERY_BRIEF_PHASE_COUNT, RECOVERY_BRIEF_HISTORY_BUDGET_CHARS - priorBudget);
	const executionHistory = priorBudget > 0
		? `Stored child-session background (may include inherited context):\n${priorHistory.text}\n\nCurrent execution:\n${history.text}`
		: history.text;

	return {
		originalTask: clip(input.task, 4_000).text || "(the original task text was not retained)",
		terminationInfo: renderTermination(input),
		executionHistory,
		recentToolCalls: renderRecentTools(input.recentTools, timeline.entries),
		recoveryReferences: renderReferences(input),
		coveredPhases: history.coveredPhases + priorHistory.coveredPhases,
		truncated: timeline.clipped || history.truncated || prior.clipped || priorHistory.truncated,
	};
}
