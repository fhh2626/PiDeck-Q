/**
 * Composer completion 的纯生命周期策略。
 *
 * completion 只能由真实文本输入创建；文本更新和候选提交都必须携带同一个
 * session 的区间与 id，避免关闭菜单、过期候选或其他会话修改不相关正文。
 */

import {
	getCompletionSearchQuery,
	isAbsolutePathCompletionPrefix,
	isInsideComposerUrl,
} from "./chips";

export type CompletionChar = "@" | "/" | "&";

export type CompletionSession = {
	id: number;
	char: CompletionChar;
	start: number;
	end: number;
	query: string;
	dismissed: boolean;
};

export type CompletionApplyResult = {
	text: string;
	cursor: number;
};

/** 判断一个真实输入的触发符是否处于可以开启补全的边界。 */
export function canStartCompletion(
	text: string,
	start: number,
	char: CompletionChar,
	validSessionRefs?: Set<string>,
): boolean {
	if (start < 0 || text[start] !== char) return false;
	// URL punctuation has the same visual boundaries as normal prose, but it must
	// never become a composer trigger. Checking the complete URL is necessary for
	// query-string cases such as `https://example.test/?x=&`.
	if (isInsideComposerUrl(text, start)) return false;

	const prev = text[start - 1] ?? "";
	if (!prev) return char !== "&" || validSessionRefs === undefined || validSessionRefs.size > 0;

	if (char === "&") {
		if (validSessionRefs?.size === 0) return false;
		return !/[:/.#!~?=&\w]/.test(prev);
	}

	// Keep slash commands usable after prose (`please /compact`) while rejecting
	// URL/path separators and mid-word slashes. This is the same boundary used by
	// parseRichInputChips.
	return !/[:/.\w#!~]/.test(prev);
}

/** 判断当前 completion 查询是否仍属于该触发符的可编辑 token。 */
export function isValidCompletionQuery(
	char: CompletionChar,
	query: string,
	validSessionRefs?: Set<string>,
): boolean {
	if (char === "/") {
		return /^[\p{L}\p{N}_:-]*$/u.test(query);
	}

	if (char === "@") {
		if (/[\r\n@&]/.test(query)) return false;

		// Once an explicit @ query has an absolute-path prefix, spaces are part of
		// the path while it is being edited. Static chip parsing uses a stricter
		// boundary heuristic; active completion must not guess where a final
		// directory name ends.
		if (isAbsolutePathCompletionPrefix(getCompletionSearchQuery(query))) return true;

		// Relative quoted paths have an explicit boundary; an unclosed quote is
		// allowed while the user is still typing it.
		if (query.startsWith('"')) {
			const closingQuote = query.indexOf('"', 1);
			return closingQuote < 0 || closingQuote === query.length - 1;
		}
		// Ordinary @foo ends at whitespace.
		return !/\s/.test(query);
	}

	if (char === "&") {
		if (/[\r\n@&]/.test(query)) return false;
		if (!validSessionRefs) return !/\s/.test(query);
		if (!query) return true;

		// Session names may be paths and may contain spaces. The whitelist is the
		// authoritative grammar, so use prefix matching instead of rejecting `/`, `:`
		// or whitespace up front.
		const lower = query.toLowerCase();
		for (const ref of validSessionRefs) {
			if (ref.toLowerCase().startsWith(lower)) return true;
		}
		return false;
	}

	return false;
}

/**
 * 依据创建 session 的起点和当前文档光标重新计算查询。
 * 这是文档变更路径，允许插入和删除让 end 双向变化；纯光标移动由
 * canKeepCompletionAtCursor 单独校验，避免两种事件语义混在一起。
 */
export function updateCompletion(
	session: CompletionSession | null,
	text: string,
	cursor: number,
	validSessionRefs?: Set<string>,
): CompletionSession | null {
	if (!session) return null;
	if (session.start < 0 || session.end < session.start || text[session.start] !== session.char) {
		return null;
	}
	// This function runs after a document mutation, not after a bare selection
	// move. The mutation may be insertion or deletion, so end must be allowed to
	// move in either direction; onCursorChange owns the separate caret-movement
	// guard.
	if (cursor < session.start + 1 || cursor > text.length) return null;

	const query = text.slice(session.start + 1, cursor);
	if (!isValidCompletionQuery(session.char, query, validSessionRefs)) return null;

	return {
		...session,
		end: cursor,
		query,
	};
}

/**
 * TipTap may emit selectionUpdate independently of document updates. A bare caret
 * move is allowed to keep completion alive only at the exact session end; unlike
 * updateCompletion, it must never expand or shrink the replacement range.
 */
export function canKeepCompletionAtCursor(
	session: CompletionSession,
	text: string,
	cursor: number,
): boolean {
	return cursor === session.end &&
		text.slice(session.start, session.end) === session.char + session.query;
}

/**
 * 在创建 completion 的区间内安全替换候选。
 * 过期/失配 session 必须返回 null；绝不能退回到“插入当前光标”的兼容逻辑，
 * 否则旧弹层点击会把内容插到新正文里。
 */
export function applyCompletion(
	text: string,
	session: CompletionSession,
	value: string,
): CompletionApplyResult | null {
	if (session.dismissed) return null;

	if (
		session.start < 0 ||
		session.end < session.start ||
		session.end > text.length
	) {
		return null;
	}

	const expected = session.char + session.query;
	if (text.slice(session.start, session.end) !== expected) return null;

	const suffix = text.slice(session.end);
	const needsSpace = suffix.length === 0 || !/^\s/.test(suffix);
	const inserted = needsSpace ? `${value} ` : value;
	const next = text.slice(0, session.start) + inserted + suffix;

	return {
		text: next,
		cursor: session.start + inserted.length,
	};
}
