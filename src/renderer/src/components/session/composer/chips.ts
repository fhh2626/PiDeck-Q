/**
 * Composer / 时间线共用的 chip 解析与路径格式化。
 * 纯函数模块：无 React / 无编辑器依赖；与显式 completion 边界对齐。
 */

export type ComposerChip = {
	start: number;
	end: number;
	raw: string;
	kind: "file" | "skill" | "session";
	label: string;
};

/** @deprecated 兼容旧名；新代码用 ComposerChip */
export type RichInputChip = ComposerChip;

/** 提取文本中所有 URL 区间，后续 chip 解析跳过这些区间。 */
function findUrlSpans(text: string): { start: number; end: number }[] {
	const urlRe = /https?:\/\/\S+/g;
	const spans: { start: number; end: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = urlRe.exec(text)) !== null) {
		spans.push({ start: m.index, end: m.index + m[0].length });
	}
	return spans;
}

/** 判断区间是否与任一 URL 区间重叠（含部分重叠）。 */
function overlapsUrl(
	start: number,
	end: number,
	urlSpans: { start: number; end: number }[],
): boolean {
	return urlSpans.some((s) => start < s.end && end > s.start);
}

/** 判断触发符位置是否已经落在 URL 中，供输入期 completion 与展示期 parser 共用。 */
export function isInsideComposerUrl(text: string, position: number): boolean {
	return overlapsUrl(position, position + 1, findUrlSpans(text));
}

/**
 * 绝对路径 completion 的规范化结果。end 是原 query 中路径 token 的结束偏移；
 * 未加引号的路径遇到无法确认属于路径的普通正文时，end 会停在正文之前，
 * 这样候选提交只替换路径，不会删除后面的用户文字。
 */
export type AbsolutePathCompletionQuery = {
	path: string;
	end: number;
};

function isAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}

/**
 * 解析 @ 后的绝对路径 query。
 * 引号提供明确边界；未加引号的带空格路径沿用展示 parser 的规则：只有后续
 * segment 自身含路径分隔符才继续并入，避免把普通正文或 URL 吞进 raw-path 候选。
 */
export function getAbsolutePathCompletionQuery(
	query: string,
): AbsolutePathCompletionQuery | null {
	if (!query) return null;

	if (query.startsWith('"')) {
		const closingQuote = query.indexOf('"', 1);
		if (closingQuote >= 0 && closingQuote !== query.length - 1) return null;
		const path = closingQuote === query.length - 1
			? query.slice(1, -1)
			: query.slice(1);
		return isAbsolutePath(path) ? { path, end: query.length } : null;
	}

	const firstToken = /^[^\s]+/.exec(query)?.[0];
	if (!firstToken || !isAbsolutePath(firstToken)) return null;

	let end = firstToken.length;
	while (end < query.length) {
		const whitespace = /^[ \t]+/.exec(query.slice(end));
		if (!whitespace) break;
		const segmentStart = end + whitespace[0].length;
		if (segmentStart >= query.length) break;
		const segment = /^[^\s]+/.exec(query.slice(segmentStart))?.[0];
		// A slash immediately after a separator is more likely a new /command
		// (`@path /compact`) than a Windows-valid path segment; preserve the old
		// command boundary and avoid pinning @ completion over the command.
		if (!segment || /^https?:\/\//i.test(segment) || /^[\\/]/.test(segment) || !/[\\/]/.test(segment)) break;
		end = segmentStart + segment.length;
	}

	return { path: query.slice(0, end), end };
}

/** 去除 quoted @ query 的语法引号，供文件候选的模糊搜索使用。 */
export function getCompletionSearchQuery(query: string): string {
	if (!query.startsWith('"')) return query;
	const body = query.slice(1);
	return body.endsWith('"') ? body.slice(0, -1) : body;
}

/**
 * 从 file chip 的 raw 取出真实路径。
 * 支持 @path、@path/、@"path with space" 三种写法。
 * 目录引用的尾斜杠会剥离，便于 open/showInFolder 使用真实路径。
 */
export function unwrapFileChipPath(raw: string): string {
	const body = raw.startsWith("@") ? raw.slice(1) : raw;
	let path =
		body.length >= 2 && body.startsWith('"') && body.endsWith('"')
			? body.slice(1, -1)
			: body;
	// 统一去掉目录标记尾斜杠（含 Windows 反斜杠），避免 FS API 拿到 "src/"
	path = path.replace(/[/\\]+$/, "");
	return path;
}

/**
 * 将路径格式化为消息中的 @ 引用。
 * 目录必须带尾斜杠（@src/），否则 chip 规则要求路径含 /\. 时，
 * 裸名 @src 不会渲染为文件 chip，模型也容易当成「智能体/人」mention。
 */
export function formatFilePathRef(
	path: string,
	options?: { isDirectory?: boolean },
): string {
	// 先规范化：去掉已有尾分隔符，再按 isDirectory 统一追加 /
	let normalized = path.replace(/[/\\]+$/, "");
	if (options?.isDirectory) {
		normalized = `${normalized}/`;
	}
	const needsQuote = /[\s"]/.test(normalized);
	if (!needsQuote) return `@${normalized}`;
	// 路径内若已有双引号，做简单转义；Windows 路径通常不含 "。
	const escaped = normalized.replace(/"/g, '\\"');
	return `@"${escaped}"`;
}

/**
 * 从粘贴文本中识别「单条本地绝对路径」：trim 后整段即为一条绝对路径
 * （允许前缀 @、外层成对引号——兼容 Windows 资源管理器「复制为路径」）。
 * 仅供明确的路径来源消费者识别单条绝对路径；普通 text/plain composer 粘贴
 * 不调用它，而是保留原文交给编辑器插入。
 * 非纯路径（多行 / 夹杂正文）返回 null，不拦截普通文本粘贴。
 */
export function extractPastedPath(text: string): string | null {
	if (!text) return null;
	let body = text.trim();
	if (!body || body.includes("\n") || body.includes("\r")) return null;
	if (body.startsWith("@")) body = body.slice(1).trimStart();
	if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
		body = body.slice(1, -1).trim();
	}
	if (!body) return null;
	// 只拦截绝对路径：Windows 盘符（C:\… / C:/…）或 POSIX 根路径（/…）
	if (!/^[a-zA-Z]:[\\/]/.test(body) && !/^\//.test(body)) return null;
	return body;
}

/**
 * 将 prompt 字符串解析为 chip 列表（展示层，与 completion 边界规则对齐）。
 *
 * 规则：
 * - /skill 触发符 / 前一个字符不能是 : / 或字母/数字/下划线（\w），
 *   避免路径段（如 Agent/PiDeck、a/b）被误识别。
 * - @path 触发符 @ 前同样排除 : / 和 \w。
 * - /skill：skill 名只允许字母开头 + 字母数字/连字符（skill 命名规范），
 *   且 token 后一字符不能是 /（排除 /usr/bin 这类路径）。
 * - @path：无空格路径用 @C:\a\b.txt；含空格路径用 @"C:\Users\a b\c.txt"。
 * - &session：传入 validSessionRefs（含空 Set）时仅白名单命中才成 chip；
 *   未传入时（时间线展示）回退为 & 后首个单词。
 *
 * URL 中的路径段（如 https://example.com/foo）不会被识别为 chip。
 */
export function parseRichInputChips(
	text: string,
	validCommandNames?: Set<string>,
	validFilePaths?: Set<string>,
	validSessionRefs?: Set<string>,
): ComposerChip[] {
	const chips: ComposerChip[] = [];
	const urlSpans = findUrlSpans(text);

	// /skill：前置排除 : / 和 \w；slash 命令 = 命令名 + 可选 :参数名。
	// 后一字符若为 /，说明是路径（如 /usr/bin），不当作 skill。
	const slashRe =
		/(?<![:/.\w#!~])(\/[\p{L}][\p{L}\p{N}_-]*(?::[\p{L}][\p{L}\p{N}_-]*)?)/gu;
	let m: RegExpExecArray | null;
	while ((m = slashRe.exec(text)) !== null) {
		const start = m.index;
		const end = start + m[1].length;
		if (text[end] === "/") continue;
		if (!overlapsUrl(start, end, urlSpans)) {
			const label = m[1].slice(1);
			if (!validCommandNames || validCommandNames.has(label)) {
				chips.push({ start, end, raw: m[1], kind: "skill", label });
			}
		}
		if (m.index === slashRe.lastIndex) slashRe.lastIndex++;
	}

	// @path：无空格 / 引号含空格 / 目录尾斜杠；未加引号的绝对路径可含空格（逐段延伸）；
	// 相对路径走白名单，绝对路径绕过。
	const atRe = /(?<![:/.\w#!~])(@(?:"[^"]+"|[^\s@"]+))/g;
	while ((m = atRe.exec(text)) !== null) {
		const start = m.index;
		let rawToken = m[1];
		let end = start + rawToken.length;
		// 未加引号的绝对路径：空格可能属于路径本身（@C:/Users/…/Tencent Files/…）。
		// 只有「下一段含 / 或 \ 」才并入，避免把后续正文/URL 吞进路径；
		// 引号形式（@"…"）有明确边界，不需要延伸。
		if (!rawToken.includes('"')) {
			const body = rawToken.slice(1);
			const isAbsPrefix = /^[a-zA-Z]:[\\/]/.test(body) || /^\//.test(body);
			if (isAbsPrefix) {
				while (end < text.length) {
					const segMatch = /^([ \t]+)([^\s]+)/.exec(text.slice(end));
					if (!segMatch) break;
					const seg = segMatch[2];
					if (!/[\\/]/.test(seg) || /^[\\/]/.test(seg) || /^https?:\/\//i.test(seg)) break;
					rawToken += `${segMatch[1]}${seg}`;
					end += segMatch[0].length;
				}
			}
		}
		if (!overlapsUrl(start, end, urlSpans)) {
			const body = rawToken.startsWith("@") ? rawToken.slice(1) : rawToken;
			const quoted = body.length >= 2 && body.startsWith('"') && body.endsWith('"');
			const rawPath = quoted ? body.slice(1, -1) : body;
			const isDirectoryRef = /[/\\]$/.test(rawPath);
			// 无分隔符且非目录尾斜杠的裸名（@alice）不渲染为文件 chip
			if (!isDirectoryRef && !/[\\/.]/.test(rawPath)) continue;
			const seg = unwrapFileChipPath(rawToken);
			const normalized = seg.replace(/\\/g, "/");
			const pathKey = normalized.startsWith("./") ? normalized.slice(2) : normalized;
			const isAbsPath =
				/^[a-zA-Z]:[\\/]/.test(pathKey) || /^\/[^/]+\//.test(pathKey);
			if (!isAbsPath && validFilePaths && !validFilePaths.has(pathKey)) continue;
			const baseLabel = pathKey || normalized || seg;
			const label = isDirectoryRef
				? `${baseLabel.replace(/[/\\]+$/, "")}/`
				: baseLabel;
			// 被延伸过的未加引号路径（含空格）规范化为 @"…" 形式：
			// 保证发送/回显（序列化）后仍是完整可解析的引用，与选择器插入的格式一致。
			const raw =
				rawToken !== m[1]
					? formatFilePathRef(rawPath, { isDirectory: isDirectoryRef })
					: rawToken;
			chips.push({ start, end, raw, kind: "file", label });
		}
		if (m.index === atRe.lastIndex) atRe.lastIndex++;
	}

	// &session：逐个 & 起点匹配，命中后把 lastIndex 推到 chip 末尾，
	// 避免旧版 (&[^\n]+) 贪婪吃掉整行导致一行只能出一个 session chip。
	// \w 还要排除 cmd&name 这类正文中的内嵌 ampersand。
	const ampStartRe = /(?<![:/.#!~?=&\w])&/gu;
	while ((m = ampStartRe.exec(text)) !== null) {
		const start = m.index;
		const captured = text.slice(start + 1);
		let name = "";
		if (validSessionRefs !== undefined) {
			// Composer：传入 Set（可为 empty）= 严格白名单，未命中不成 chip。
			// 与 completion/发送解析一致，session 名比较不区分大小写。
			const capturedLower = captured.toLowerCase();
			for (const ref of validSessionRefs) {
				const refLower = ref.toLowerCase();
				if (
					capturedLower === refLower ||
					capturedLower.startsWith(`${refLower} `) ||
					capturedLower.startsWith(`${refLower}\n`)
				) {
					if (ref.length > name.length) name = ref;
				}
			}
			if (!name) {
				continue;
			}
		} else {
			// 时间线等未传白名单：回退首词（仅展示）
			name = captured.split(/\s/)[0] ?? "";
		}
		if (!name) continue;
		const raw = `&${name}`;
		const end = start + raw.length;
		if (!overlapsUrl(start, end, urlSpans)) {
			chips.push({ start, end, raw, kind: "session", label: name });
		}
		ampStartRe.lastIndex = end;
	}

	// 去重叠：保留先出现的，剔除被包含的
	chips.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: ComposerChip[] = [];
	let coverEnd = -1;
	for (const c of chips) {
		if (c.start >= coverEnd) {
			merged.push(c);
			coverEnd = c.end;
		}
	}
	return merged;
}
