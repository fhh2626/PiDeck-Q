/**
 * Composer completion 的纯生命周期策略。
 *
 * completion 只能由真实文本输入创建；文本更新和候选提交都必须携带同一个
 * session 的区间与 id，避免关闭菜单、过期候选或其他会话修改不相关正文。
 */

import {
	getAbsolutePathCompletionQuery,
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

		// Absolute paths use the same segment-aware boundary as chip parsing. A
		// trailing ordinary phrase is handled by updateCompletion, which keeps only
		// the path portion replaceable instead of allowing raw-path to swallow it.
		if (getAbsolutePathCompletionQuery(query)) return true;

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
 * 依据创建 session 的固定区间更新查询。
 * 光标只能在 token 尾部继续向前；一旦回到 token 中间或触发符被删除，
 * session 结束，避免后续候选替换到用户已经离开的正文位置。
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
	if (cursor < session.start + 1 || cursor < session.end || cursor > text.length) {
		return null;
	}

	const fullQuery = text.slice(session.start + 1, cursor);
	if (!isValidCompletionQuery(session.char, fullQuery, validSessionRefs)) return null;

	let end = cursor;
	let query = fullQuery;
	if (session.char === "@") {
		const absolutePath = getAbsolutePathCompletionQuery(fullQuery);
		if (absolutePath) {
			end = session.start + 1 + absolutePath.end;
			const trailingText = text.slice(end, cursor);
			// A path may be followed by a separator while the menu remains open, but
			// once ordinary text starts the completion is dismissed. This prevents a
			// raw-path candidate from replacing `@path` plus the user's explanation.
			if (/\S/.test(trailingText)) return null;
			query = text.slice(session.start + 1, end);
		}
	}

	return {
		...session,
		end,
		query,
	};
}

/**
 * TipTap may emit selectionUpdate after the document update. Absolute paths with
 * spaces intentionally have a replacement range shorter than the live caret, so
 * that event must not dismiss the session when the gap contains only whitespace.
 */
export function canKeepCompletionAtCursor(
	session: CompletionSession,
	text: string,
	cursor: number,
): boolean {
	if (cursor === session.end) return true;
	if (session.char !== "@" || cursor < session.end) return false;

	const currentQuery = text.slice(session.start + 1, session.end);
	const currentPath = getAbsolutePathCompletionQuery(currentQuery);
	if (!currentPath || currentPath.end !== currentQuery.length) return false;

	const nextQuery = text.slice(session.start + 1, cursor);
	const nextPath = getAbsolutePathCompletionQuery(nextQuery);
	return Boolean(
		nextPath &&
		nextPath.end === currentQuery.length &&
		!/\S/.test(nextQuery.slice(nextPath.end)),
	);
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
