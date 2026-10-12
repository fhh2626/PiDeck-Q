import { randomUUID } from "node:crypto";
import {
	open as openFile,
	readFile,
	realpath,
	readdir,
	rename,
	unlink,
	type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";

export type SessionFileEnvironment = "native" | "wsl";

export type SessionFileRef = {
	protocolPath: string;
	hostPath: string;
	environment: SessionFileEnvironment;
	wslDistro?: string;
};

export type SessionEntryTarget = {
	entryId?: string;
	legacyMessageId?: string;
	legacyAgentId?: string;
	role: "user" | "assistant";
	text: string;
	activeLeafId?: string;
};

export type SessionMutationResult = {
	targetEntryId: string;
	changedEntryIds: string[];
	backupPath: string;
};

export type SessionFileEditorErrorCode =
	| "SESSION_FILE_EMPTY"
	| "SESSION_FILE_INVALID_JSONL"
	| "SESSION_ENTRY_NOT_FOUND"
	| "SESSION_ENTRY_AMBIGUOUS"
	| "SESSION_ENTRY_ROLE_INVALID"
	| "SESSION_FILE_CHANGED"
	| "SESSION_BACKUP_FAILED"
	| "SESSION_ATOMIC_WRITE_FAILED"
	| "SESSION_RELOAD_FAILED"
	| "SESSION_ROLLBACK_FAILED"
	| "SESSION_ROLLBACK_RELOAD_FAILED"
	| "SESSION_ROLLBACK_CONFLICT"
	| "SESSION_MARKER_CONFLICT";

export class SessionFileEditorError extends Error {
	readonly code: SessionFileEditorErrorCode;
	readonly details?: Record<string, string | number>;
	readonly backupPath?: string;

	constructor(
		code: SessionFileEditorErrorCode,
		message: string,
		options: {
			cause?: unknown;
			details?: Record<string, string | number>;
			backupPath?: string;
		} = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "SessionFileEditorError";
		this.code = code;
		this.details = options.details;
		this.backupPath = options.backupPath;
	}
}

type WritableFileHandle = Pick<FileHandle, "writeFile" | "sync" | "close">;

export type SessionFileEditorFs = {
	readFile(path: string): Promise<Buffer>;
	realpath(path: string): Promise<string>;
	open(path: string, flags: "wx"): Promise<WritableFileHandle>;
	readdir(path: string): Promise<string[]>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
};

export type SessionFileEditorLogger = {
	warn(message: string, details?: Record<string, unknown>): void | Promise<void>;
};

export type SessionFileEditorOptions = {
	fs?: Partial<SessionFileEditorFs>;
	now?: () => number;
	randomUUID?: () => string;
	sleep?: (milliseconds: number) => Promise<void>;
	logger?: SessionFileEditorLogger;
	maxBackups?: number;
};

type JsonlEntry = Record<string, unknown>;

type JsonlLine = {
	content: string;
	eol: string;
	entry?: JsonlEntry;
};

type JsonlDocument = {
	lines: JsonlLine[];
	entryLineById: Map<string, number>;
};

type LocatedEntry = {
	lineIndex: number;
	entry: JsonlEntry;
	entryId: string;
};

type MutationKind = "edit" | "delete" | "resend";

type MutationInput = {
	file: SessionFileRef;
	target: SessionEntryTarget;
	reload: () => Promise<void>;
};

class ReloadAttemptFailure extends Error {
	constructor(
		readonly error: unknown,
		readonly ownedStates: Buffer[],
	) {
		super("Session reload attempt failed", { cause: error });
	}
}

const defaultFs: SessionFileEditorFs = {
	readFile: (path) => readFile(path),
	realpath,
	open: (path, flags) => openFile(path, flags),
	readdir,
	rename,
	unlink,
};

const sharedFileLocks = new Map<string, Promise<void>>();

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as { code?: unknown }).code ?? "")
		: undefined;
}

function normalizePhysicalPath(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	const wslUnc = slashed.match(/^\/\/wsl(?:\.localhost|\$)\/([^/]+)(\/.*)?$/i);
	if (wslUnc) {
		return `wsl-unc\u0000${wslUnc[1].toLowerCase()}\u0000${posix.normalize(wslUnc[2] || "/")}`;
	}
	return `host\u0000${win32.normalize(path).replaceAll("\\", "/").toLowerCase()}`;
}

function entryIdOf(entry: JsonlEntry): string | undefined {
	if (typeof entry.id === "string" && entry.id) return entry.id;
	if (typeof entry.entryId === "string" && entry.entryId) return entry.entryId;
	return undefined;
}

function parentIdOf(entry: JsonlEntry): string | null | undefined {
	if (entry.parentId === null) return null;
	return typeof entry.parentId === "string" ? entry.parentId : undefined;
}

function messageOf(entry: JsonlEntry): Record<string, unknown> | undefined {
	return entry.message && typeof entry.message === "object" && !Array.isArray(entry.message)
		? entry.message as Record<string, unknown>
		: undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text))
		.join("");
}

function setMessageText(message: Record<string, unknown>, text: string): void {
	const content = message.content;
	if (typeof content === "string") {
		message.content = text;
		return;
	}
	if (Array.isArray(content)) {
		const next: unknown[] = [];
		let replacedText = false;
		for (const candidate of content) {
			const isText = Boolean(
				candidate && typeof candidate === "object" &&
				(candidate as Record<string, unknown>).type === "text",
			);
			if (!isText) {
				next.push(candidate);
				continue;
			}
			if (replacedText) continue;
			next.push({ ...(candidate as Record<string, unknown>), text });
			replacedText = true;
		}
		if (!replacedText) next.push({ type: "text", text });
		content.splice(0, content.length, ...next);
		return;
	}
	message.content = [{ type: "text", text }];
}

function splitJsonl(text: string): JsonlLine[] {
	if (!text) return [];
	const lines: JsonlLine[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character !== "\r" && character !== "\n") continue;
		let eol = character;
		if (character === "\r" && text[index + 1] === "\n") {
			eol = "\r\n";
			index += 1;
		}
		const end = index + 1 - eol.length;
		lines.push({ content: text.slice(start, end), eol });
		start = index + 1;
	}
	if (start < text.length) lines.push({ content: text.slice(start), eol: "" });
	return lines;
}

function parseDocument(bytes: Buffer): JsonlDocument {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (cause) {
		throw new SessionFileEditorError(
			"SESSION_FILE_INVALID_JSONL",
			"Session file is not valid UTF-8",
			{ cause },
		);
	}
	const lines = splitJsonl(text);
	if (!lines.some((line) => line.content.trim())) {
		throw new SessionFileEditorError("SESSION_FILE_EMPTY", "Session file is empty");
	}

	const entryLineById = new Map<string, number>();
	let sessionHeaderCount = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.content.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line.content);
		} catch (cause) {
			throw new SessionFileEditorError(
				"SESSION_FILE_INVALID_JSONL",
				`Session file contains invalid JSONL at line ${index + 1}`,
				{ cause, details: { line: index + 1 } },
			);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new SessionFileEditorError(
				"SESSION_FILE_INVALID_JSONL",
				`Session file contains a non-object entry at line ${index + 1}`,
				{ details: { line: index + 1 } },
			);
		}
		line.entry = parsed as JsonlEntry;
		// 墓碑也要进 id 索引：pi 会把最后一条带 id 的记录当 leaf，再沿 parentId
		// 回溯。旧墓碑没有 id，这里仍会跳过（entryIdOf 为空）。
		if (line.entry.type === "session") sessionHeaderCount += 1;
		const entryId = entryIdOf(line.entry);
		if (entryId) {
			if (entryLineById.has(entryId)) {
				throw new SessionFileEditorError(
					"SESSION_FILE_INVALID_JSONL",
					`Session file contains duplicate entry ID ${entryId}`,
					{ details: { line: index + 1 } },
				);
			}
			entryLineById.set(entryId, index);
		}
	}
	if (sessionHeaderCount !== 1) {
		throw new SessionFileEditorError(
			"SESSION_FILE_INVALID_JSONL",
			`Session file must contain exactly one session header; found ${sessionHeaderCount}`,
		);
	}

	for (const [entryId, lineIndex] of entryLineById) {
		const parentId = parentIdOf(lines[lineIndex].entry!);
		if (parentId && !entryLineById.has(parentId)) {
			throw new SessionFileEditorError(
				"SESSION_FILE_INVALID_JSONL",
				`Session entry ${entryId} has a dangling parent ${parentId}`,
				{ details: { line: lineIndex + 1 } },
			);
		}
	}

	const completed = new Set<string>();
	for (const entryId of entryLineById.keys()) {
		const visiting = new Set<string>();
		let current: string | null | undefined = entryId;
		while (current && !completed.has(current)) {
			if (visiting.has(current)) {
				throw new SessionFileEditorError(
					"SESSION_FILE_INVALID_JSONL",
					`Session entry graph contains a cycle at ${current}`,
				);
			}
			visiting.add(current);
			const lineIndex = entryLineById.get(current);
			current = lineIndex === undefined ? undefined : parentIdOf(lines[lineIndex].entry!);
		}
		for (const visited of visiting) completed.add(visited);
	}
	return { lines, entryLineById };
}

function serializeDocument(document: JsonlDocument): Buffer {
	return Buffer.from(
		document.lines.map((line) => `${line.content}${line.eol}`).join(""),
		"utf8",
	);
}

function replaceLine(document: JsonlDocument, lineIndex: number, entry: JsonlEntry): void {
	document.lines[lineIndex].entry = entry;
	document.lines[lineIndex].content = JSON.stringify(entry);
}

function legacyEntryId(target: SessionEntryTarget): string | undefined {
	if (!target.legacyMessageId || !target.legacyAgentId) return undefined;
	const prefix = `${target.legacyAgentId}-history-`;
	return target.legacyMessageId.startsWith(prefix)
		? target.legacyMessageId.slice(prefix.length)
		: undefined;
}

function validateLocatedRole(entry: JsonlEntry, target: SessionEntryTarget): void {
	const role = messageOf(entry)?.role;
	if (role !== target.role) {
		throw new SessionFileEditorError(
			"SESSION_ENTRY_ROLE_INVALID",
			`Session entry role ${String(role)} cannot be used as ${target.role}`,
		);
	}
}

function locateById(
	document: JsonlDocument,
	entryId: string | undefined,
	target: SessionEntryTarget,
	activeIds: Set<string>,
): LocatedEntry | undefined {
	if (!entryId) return undefined;
	const lineIndex = document.entryLineById.get(entryId);
	if (lineIndex === undefined) return undefined;
	if (!activeIds.has(entryId)) {
		throw new SessionFileEditorError(
			"SESSION_ENTRY_NOT_FOUND",
			"The requested entry is not part of the active session branch",
		);
	}
	const entry = document.lines[lineIndex].entry!;
	if (entry.type === "deleted") {
		throw new SessionFileEditorError(
			"SESSION_ENTRY_NOT_FOUND",
			"The requested entry has already been deleted",
		);
	}
	validateLocatedRole(entry, target);
	return { lineIndex, entry, entryId };
}

function activeBranchIds(document: JsonlDocument, activeLeafId?: string): Set<string> {
	let leafId = activeLeafId;
	if (leafId && !document.entryLineById.has(leafId)) {
		throw new SessionFileEditorError(
			"SESSION_ENTRY_NOT_FOUND",
			"The active session branch is no longer present in the file",
		);
	}
	if (!leafId) {
		for (let index = document.lines.length - 1; index >= 0; index -= 1) {
			const entry = document.lines[index].entry;
			if (!entry || entry.type === "deleted") continue;
			const candidate = entryIdOf(entry);
			if (candidate) {
				leafId = candidate;
				break;
			}
		}
	}
	if (!leafId) return new Set();

	const result = new Set<string>();
	let current: string | null | undefined = leafId;
	while (current && !result.has(current)) {
		result.add(current);
		const lineIndex = document.entryLineById.get(current);
		if (lineIndex === undefined) break;
		current = parentIdOf(document.lines[lineIndex].entry!);
	}
	return result;
}

function locateEntry(document: JsonlDocument, target: SessionEntryTarget): LocatedEntry {
	const branchIds = activeBranchIds(document, target.activeLeafId);
	const exact = locateById(document, target.entryId, target, branchIds);
	if (exact) return exact;
	const legacy = locateById(document, legacyEntryId(target), target, branchIds);
	if (legacy) return legacy;

	const candidates: LocatedEntry[] = [];
	for (const entryId of branchIds) {
		const lineIndex = document.entryLineById.get(entryId);
		if (lineIndex === undefined) continue;
		const entry = document.lines[lineIndex].entry!;
		const message = messageOf(entry);
		if (message?.role !== target.role || textOf(message.content) !== target.text) continue;
		candidates.push({ lineIndex, entry, entryId });
	}

	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1) {
		throw new SessionFileEditorError(
			"SESSION_ENTRY_AMBIGUOUS",
			"More than one entry matches the requested message on the active branch",
			{ details: { matches: candidates.length } },
		);
	}
	throw new SessionFileEditorError(
		"SESSION_ENTRY_NOT_FOUND",
		"Message was not found on the active session branch",
	);
}

/**
 * 整轮删除时要墓碑的消息条目 id（活动分支顺序，根→叶）。
 *
 * 业务规则：界面上一个「轮次」就是一个删除单元。
 * - 目标是 user：从它开始，到下一条 user 之前（不含）。
 * - 目标是 assistant/toolResult：先回退到本轮 user 锚点，再取锚点之后到下一条 user 之前。
 *   没有锚点（缓存被裁剪/一轮开头就是 assistant）时从活动分支起点开始。
 * 为什么必须整轮删：只删最终回答会留下悬空的 toolCall（pi 下一轮请求直接报错），
 * 只删 user 会把它的回复改挂到上一轮，界面表现为「上一轮多了两段回答」。
 * 只处理 type === "message"：model_change 等设置类条目不属于对话内容，
 * 删掉会连带丢掉用户手动切换的模型/思考等级。
 */
function turnSegmentMessageIds(
	document: JsonlDocument,
	targetEntryId: string,
	activeLeafId: string | undefined,
): string[] {
	const branchIds = [...activeBranchIds(document, activeLeafId)].reverse();
	const entryAt = (entryId: string): JsonlEntry | undefined => {
		const lineIndex = document.entryLineById.get(entryId);
		return lineIndex === undefined ? undefined : document.lines[lineIndex].entry;
	};
	const isUserMessage = (entryId: string): boolean => {
		const entry = entryAt(entryId);
		return entry?.type === "message" && inputRole(entry) === "user";
	};

	const targetIndex = branchIds.indexOf(targetEntryId);
	if (targetIndex < 0) {
		throw new SessionFileEditorError(
			"SESSION_ENTRY_NOT_FOUND",
			"The requested entry is not on the active session branch",
		);
	}

	let start = targetIndex;
	if (!isUserMessage(targetEntryId)) {
		// 回退到本轮 user 锚点
		let anchor = -1;
		for (let index = targetIndex - 1; index >= 0; index -= 1) {
			if (isUserMessage(branchIds[index])) {
				anchor = index;
				break;
			}
		}
		start = anchor >= 0 ? anchor + 1 : 0;
	}

	let end = branchIds.length;
	for (let index = start + 1; index < branchIds.length; index += 1) {
		if (isUserMessage(branchIds[index])) {
			end = index;
			break;
		}
	}

	const result: string[] = [];
	for (let index = start; index < end; index += 1) {
		const entryId = branchIds[index];
		if (entryAt(entryId)?.type === "message") result.push(entryId);
	}
	return result;
}

function descendantEntryIds(document: JsonlDocument, rootEntryId: string): Set<string> {
	const descendants = new Set<string>([rootEntryId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const line of document.lines) {
			const entry = line.entry;
			if (!entry || entry.type === "deleted") continue;
			const entryId = entryIdOf(entry);
			const parentId = parentIdOf(entry);
			if (!entryId || !parentId || !descendants.has(parentId) || descendants.has(entryId)) continue;
			descendants.add(entryId);
			changed = true;
		}
	}
	return descendants;
}

/**
 * 整轮删除前修正 compaction.firstKeptEntryId，返回被改写的 compaction id。
 *
 * 为什么：pi 的 buildContextEntries 只在「活动路径上、压缩点之前」查找 firstKeptEntryId，
 * 找到后才把从它开始的保留段放进 LLM 上下文。被删条目变成墓碑后，其子节点会被改挂到
 * 幸存祖先上，墓碑不再在路径上——锚点失效，没被删的保留消息也会被静默排除出上下文。
 *
 * 规则：沿该 compaction 的原父链（删除前）取「被删锚点之后第一个幸存条目」作为新锚点；
 * 锚点到压缩点之间全被删时改为 compaction 自身 id（pi appendCompaction 同样用自身 id
 * 表示「不保留压缩点之前的条目」）。锚点不在祖先链上的异常数据不猜测，保持原值。
 *
 * 必须在改挂子节点、写墓碑之前调用：依赖原始 parentId 链。
 */
function rewriteCompactionFirstKept(document: JsonlDocument, removeSet: ReadonlySet<string>): string[] {
	const changed: string[] = [];
	for (let index = 0; index < document.lines.length; index += 1) {
		const entry = document.lines[index].entry;
		if (!entry || entry.type !== "compaction") continue;
		const compactionId = entryIdOf(entry);
		const firstKept = entry.firstKeptEntryId;
		if (!compactionId || typeof firstKept !== "string" || !removeSet.has(firstKept)) continue;

		// 沿原父链回溯到根，得到「根 → 压缩点」的祖先路径（不含压缩点自身）。
		const ancestors: string[] = [];
		const visited = new Set<string>([compactionId]);
		let cursor = parentIdOf(entry) ?? null;
		while (cursor && !visited.has(cursor)) {
			visited.add(cursor);
			ancestors.push(cursor);
			const lineIndex = document.entryLineById.get(cursor);
			const parentEntry = lineIndex === undefined ? undefined : document.lines[lineIndex].entry;
			cursor = parentEntry ? parentIdOf(parentEntry) ?? null : null;
		}
		ancestors.reverse();

		const anchorIndex = ancestors.indexOf(firstKept);
		if (anchorIndex < 0) continue;
		const nextKept = ancestors.slice(anchorIndex + 1).find((id) => !removeSet.has(id));
		replaceLine(document, index, { ...entry, firstKeptEntryId: nextKept ?? compactionId });
		changed.push(compactionId);
	}
	return changed;
}

/**
 * 删除/重发截断写入的墓碑。必须保留 id + parentId：
 * pi SessionManager._buildIndex 把文件里最后一条带 id 的记录当成 leaf，
 * 再沿 parentId 回溯活动分支。旧墓碑只有 originalEntryId，leaf 会落在
 * 这条「无 id、无父节点」的记录上，get_messages 整页变空。
 */
function tombstone(
	entryId: string,
	now: number,
	parentId?: string | null,
	reason?: string,
): JsonlEntry {
	return {
		type: "deleted",
		id: entryId,
		originalEntryId: entryId,
		parentId: parentId ?? null,
		ts: now,
		...(reason ? { reason } : {}),
	};
}

export class SessionFileEditor {
	private readonly fs: SessionFileEditorFs;
	private readonly now: () => number;
	private readonly createUuid: () => string;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly logger?: SessionFileEditorLogger;
	private readonly maxBackups: number;

	constructor(options: SessionFileEditorOptions = {}) {
		this.fs = { ...defaultFs, ...options.fs };
		this.now = options.now ?? Date.now;
		this.createUuid = options.randomUUID ?? randomUUID;
		this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
			setTimeout(resolve, milliseconds);
		}));
		this.logger = options.logger;
		this.maxBackups = Math.max(1, options.maxBackups ?? 3);
	}

	editMessage(input: MutationInput & { newText: string }): Promise<SessionMutationResult> {
		return this.mutate("edit", input, input.newText);
	}

	deleteMessage(input: MutationInput): Promise<SessionMutationResult> {
		return this.mutate("delete", input);
	}

	truncateForResend(input: MutationInput): Promise<SessionMutationResult> {
		return this.mutate("resend", input);
	}

	reload(input: { file: SessionFileRef; reload: () => Promise<void> }): Promise<void> {
		return this.withFileLock(input.file, async () => {
			try {
				await this.reloadWithMarker(input.file, input.reload);
			} catch (cause) {
				if (cause instanceof SessionFileEditorError) throw cause;
				const reloadCause = cause instanceof ReloadAttemptFailure ? cause.error : cause;
				if (reloadCause instanceof SessionFileEditorError) throw reloadCause;
				throw new SessionFileEditorError(
					"SESSION_RELOAD_FAILED",
					"Session runtime reload failed",
					{ cause: reloadCause },
				);
			}
		});
	}

	private async lockKey(file: SessionFileRef): Promise<string> {
		const physicalPath = await this.fs.realpath(file.hostPath).catch(() => file.hostPath);
		return normalizePhysicalPath(physicalPath);
	}

	private async withFileLock<T>(file: SessionFileRef, operation: () => Promise<T>): Promise<T> {
		const key = await this.lockKey(file);
		const previous = sharedFileLocks.get(key) ?? Promise.resolve();
		const current = previous.then(operation, operation);
		const tail = current.then(() => undefined, () => undefined);
		sharedFileLocks.set(key, tail);
		try {
			return await current;
		} finally {
			if (sharedFileLocks.get(key) === tail) sharedFileLocks.delete(key);
		}
	}

	private async mutate(
		kind: MutationKind,
		input: MutationInput,
		newText?: string,
	): Promise<SessionMutationResult> {
		return this.withFileLock(input.file, async () => {
			const original = await this.readSessionFile(input.file.hostPath);
			const document = parseDocument(original);
			if (document.lines.some((line) => line.entry?._reloadMarker !== undefined)) {
				throw new SessionFileEditorError(
					"SESSION_MARKER_CONFLICT",
					"Session file already contains a reload marker",
				);
			}
			const located = locateEntry(document, input.target);
			const changedEntryIds = this.applyMutation(document, located, kind, newText, input.target.activeLeafId);
			const next = serializeDocument(document);
			const backupPath = await this.createBackup(input.file.hostPath, original);

			await this.replaceIfUnchanged(input.file.hostPath, original, next, backupPath);
			try {
				await this.reloadWithMarker(input.file, input.reload, next);
			} catch (cause) {
				const reloadFailure = cause instanceof ReloadAttemptFailure
					? cause
					: new ReloadAttemptFailure(cause, [next]);
				await this.rollback(
					input,
					backupPath,
					reloadFailure.error,
					reloadFailure.ownedStates,
				);
				throw new SessionFileEditorError(
					"SESSION_RELOAD_FAILED",
					"Session reload failed; the original file and runtime were restored",
					{ cause: reloadFailure.error, backupPath },
				);
			}

			return {
				targetEntryId: located.entryId,
				changedEntryIds,
				backupPath,
			};
		});
	}

	private applyMutation(
		document: JsonlDocument,
		located: LocatedEntry,
		kind: MutationKind,
		newText?: string,
		activeLeafId?: string,
	): string[] {
		if (kind === "edit") {
			const message = messageOf(located.entry);
			if (!message || (message.role !== "user" && message.role !== "assistant")) {
				throw new SessionFileEditorError(
					"SESSION_ENTRY_ROLE_INVALID",
					"Only user and assistant message entries can be edited",
				);
			}
			setMessageText(message, newText ?? "");
			replaceLine(document, located.lineIndex, located.entry);
			return [located.entryId];
		}

		if (kind === "delete") {
			// 整轮删除：墓碑本轮全部 message 条目，再把幸存子节点接到「沿原父链向上第一个未被删的祖先」。
			// 只删单个条目会留下悬空 toolCall / 把回复串到上一轮（见 turnSegmentMessageIds 注释）。
			const removeIds = turnSegmentMessageIds(document, located.entryId, activeLeafId);
			const removeSet = new Set(removeIds);
			// 先快照所有待删条目的原 parentId：墓碑写入后再读就拿不到原父链了。
			const originalParentById = new Map<string, string | null>();
			for (const entryId of removeIds) {
				const lineIndex = document.entryLineById.get(entryId);
				if (lineIndex === undefined) continue;
				const entry = document.lines[lineIndex].entry;
				if (!entry) continue;
				originalParentById.set(entryId, parentIdOf(entry) ?? null);
			}
			const keptAncestor = (parentId: string | null): string | null => {
				let cursor: string | null = parentId;
				const visited = new Set<string>();
				while (cursor && removeSet.has(cursor) && !visited.has(cursor)) {
					visited.add(cursor);
					cursor = originalParentById.get(cursor) ?? null;
				}
				return cursor;
			};

			const changed: string[] = [...removeIds];
			// 先修正压缩锚点（要用删除前的父链），再改挂子节点、写墓碑。
			changed.push(...rewriteCompactionFirstKept(document, removeSet));
			// 改挂幸存子节点：包括下一条 user、分支上的非消息条目（如 model_change）
			// 以及其他分支上指向被删条目的子节点。
			for (let index = 0; index < document.lines.length; index += 1) {
				const child = document.lines[index].entry;
				if (!child || child.type === "deleted") continue;
				const childId = entryIdOf(child);
				if (childId && removeSet.has(childId)) continue;
				const childParent = parentIdOf(child) ?? null;
				if (!childParent || !removeSet.has(childParent)) continue;
				child.parentId = keptAncestor(childParent);
				replaceLine(document, index, child);
				if (childId) changed.push(childId);
			}

			for (const entryId of removeIds) {
				const lineIndex = document.entryLineById.get(entryId);
				if (lineIndex === undefined) continue;
				// 墓碑保留原 parentId：pi 靠 id + parentId 回溯活动分支，
				// 墓碑若断链会让 get_messages 整页变空。
				replaceLine(document, lineIndex, tombstone(entryId, this.now(), originalParentById.get(entryId) ?? null));
			}
			return changed;
		}

		if (inputRole(located.entry) !== "user") {
			throw new SessionFileEditorError(
				"SESSION_ENTRY_ROLE_INVALID",
				"Only user messages can be truncated for resend",
			);
		}
		const removeIds = descendantEntryIds(document, located.entryId);
		for (let index = 0; index < document.lines.length; index += 1) {
			const entry = document.lines[index].entry;
			if (!entry || entry.type === "deleted") continue;
			const entryId = entryIdOf(entry);
			if (!entryId || !removeIds.has(entryId)) continue;
			replaceLine(
				document,
				index,
				tombstone(entryId, this.now(), parentIdOf(entry), "resend-truncate"),
			);
		}
		return [...removeIds];
	}

	private async readSessionFile(path: string): Promise<Buffer> {
		try {
			return await this.fs.readFile(path);
		} catch (cause) {
			throw new SessionFileEditorError(
				"SESSION_FILE_EMPTY",
				"Session file could not be read",
				{ cause },
			);
		}
	}

	private async createBackup(path: string, original: Buffer): Promise<string> {
		const directory = dirname(path);
		const filename = basename(path);
		const stamp = String(this.now()).padStart(13, "0");
		const backupPath = join(
			directory,
			`${filename}.${stamp}-${this.createUuid()}.edit-backup`,
		);
		let handle: WritableFileHandle | undefined;
		try {
			handle = await this.fs.open(backupPath, "wx");
			await handle.writeFile(original);
			await handle.sync();
			await handle.close();
			handle = undefined;
		} catch (cause) {
			await handle?.close().catch(() => undefined);
			await this.fs.unlink(backupPath).catch(() => undefined);
			throw new SessionFileEditorError(
				"SESSION_BACKUP_FAILED",
				"Session backup could not be created",
				{ cause, backupPath },
			);
		}

		await this.pruneBackups(directory, filename, basename(backupPath));
		try {
			const verified = await this.fs.readFile(backupPath);
			if (!verified.equals(original)) throw new Error("Backup content mismatch");
		} catch (cause) {
			throw new SessionFileEditorError(
				"SESSION_BACKUP_FAILED",
				"Session backup could not be verified",
				{ cause, backupPath },
			);
		}
		return backupPath;
	}

	private async pruneBackups(
		directory: string,
		filename: string,
		protectedBackup: string,
	): Promise<void> {
		try {
			const prefix = `${filename}.`;
			const suffix = ".edit-backup";
			const backups = (await this.fs.readdir(directory))
				.filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix))
				.sort();
			while (backups.length > this.maxBackups) {
				const oldestIndex = backups.findIndex((candidate) => candidate !== protectedBackup);
				if (oldestIndex < 0) break;
				const [oldest] = backups.splice(oldestIndex, 1);
				if (oldest) await this.fs.unlink(join(directory, oldest));
			}
		} catch (error) {
			void this.logger?.warn("Session backup pruning failed", {
				directory,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async replaceIfUnchanged(
		path: string,
		expected: Buffer,
		next: Buffer,
		backupPath?: string,
	): Promise<void> {
		await this.atomicReplace(path, next, backupPath, expected);
	}

	private async atomicReplace(
		path: string,
		next: Buffer,
		backupPath?: string,
		expected?: Buffer,
	): Promise<void> {
		const tempPath = join(
			dirname(path),
			`.${basename(path)}.${process.pid}.${this.createUuid()}.tmp`,
		);
		let handle: WritableFileHandle | undefined;
		let renamed = false;
		try {
			handle = await this.fs.open(tempPath, "wx");
			await handle.writeFile(next);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.renameWithRetry(tempPath, path, expected, backupPath);
			renamed = true;
		} catch (cause) {
			if (cause instanceof SessionFileEditorError) throw cause;
			throw new SessionFileEditorError(
				"SESSION_ATOMIC_WRITE_FAILED",
				"Session file could not be replaced atomically",
				{ cause, backupPath },
			);
		} finally {
			await handle?.close().catch(() => undefined);
			if (!renamed) await this.fs.unlink(tempPath).catch(() => undefined);
		}
	}

	private async renameWithRetry(
		from: string,
		to: string,
		expected?: Buffer,
		backupPath?: string,
	): Promise<void> {
		const delays = [0, 20, 75, 200];
		let lastError: unknown;
		for (const delay of delays) {
			if (delay) await this.sleep(delay);
			try {
				if (expected) {
					const current = await this.fs.readFile(to).catch((cause) => {
						throw new SessionFileEditorError(
							"SESSION_FILE_CHANGED",
							"Session file could not be verified before committing",
							{ cause, backupPath },
						);
					});
					if (!current.equals(expected)) {
						throw new SessionFileEditorError(
							"SESSION_FILE_CHANGED",
							"Session file changed while the replacement was being committed",
							{ backupPath },
						);
					}
				}
				await this.fs.rename(from, to);
				return;
			} catch (error) {
				lastError = error;
				if (errorCode(error) !== "EPERM" && errorCode(error) !== "EBUSY") throw error;
			}
		}
		throw lastError;
	}

	private async reloadWithMarker(
		file: SessionFileRef,
		reload: () => Promise<void>,
		expectedBase?: Buffer,
	): Promise<void> {
		const markerId = this.createUuid();
		const beforeMarker = await this.readSessionFile(file.hostPath);
		if (expectedBase && !beforeMarker.equals(expectedBase)) {
			throw new SessionFileEditorError(
				"SESSION_FILE_CHANGED",
				"Session file changed before the runtime reload marker was written",
			);
		}
		const markedDocument = parseDocument(beforeMarker);
		const existingMarker = markedDocument.lines.find((line) => (
			line.entry && line.entry._reloadMarker !== undefined
		));
		if (existingMarker) {
			throw new SessionFileEditorError(
				"SESSION_MARKER_CONFLICT",
				"Session file already contains a reload marker",
			);
		}
		const markerLineIndex = markedDocument.lines.findIndex((line) => line.entry?.type === "session");
		if (markerLineIndex < 0) {
			throw new SessionFileEditorError("SESSION_FILE_EMPTY", "Session file has no header entry");
		}
		const originalLine = markedDocument.lines[markerLineIndex].content;
		const markerEntry = markedDocument.lines[markerLineIndex].entry!;
		delete markerEntry._reloadMarker;
		markerEntry._reloadMarker = markerId;
		replaceLine(markedDocument, markerLineIndex, markerEntry);
		const markedLine = markedDocument.lines[markerLineIndex].content;
		const markedBytes = serializeDocument(markedDocument);
		await this.replaceIfUnchanged(file.hostPath, beforeMarker, markedBytes);

		let reloadError: unknown;
		try {
			await reload();
		} catch (error) {
			reloadError = error;
		} finally {
			try {
				const current = await this.fs.readFile(file.hostPath);
				const cleanupDocument = parseDocument(current);
				const ownMarkerLines = cleanupDocument.lines.filter(
					(line) => line.entry?._reloadMarker === markerId,
				);
				if (ownMarkerLines.length > 1) {
					throw new SessionFileEditorError(
						"SESSION_MARKER_CONFLICT",
						"Session reload marker appears more than once",
					);
				}
				const cleanupLine = ownMarkerLines[0];
				if (cleanupLine) {
					if (cleanupLine.content === markedLine) {
						cleanupLine.content = originalLine;
						cleanupLine.entry = JSON.parse(originalLine) as JsonlEntry;
					} else {
						delete cleanupLine.entry!._reloadMarker;
						cleanupLine.content = JSON.stringify(cleanupLine.entry);
					}
					await this.replaceIfUnchanged(
						file.hostPath,
						current,
						serializeDocument(cleanupDocument),
					);
				} else if (cleanupDocument.lines.some((line) => line.entry?._reloadMarker !== undefined)) {
					throw new SessionFileEditorError(
						"SESSION_MARKER_CONFLICT",
						"Session reload marker ownership changed during reload",
					);
				}
			} catch (cleanupError) {
				if (!reloadError) reloadError = cleanupError;
				else {
					void this.logger?.warn("Session reload marker cleanup failed", {
						path: file.hostPath,
						error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					});
				}
			}
		}

		if (reloadError) {
			throw new ReloadAttemptFailure(
				reloadError,
				[expectedBase ?? beforeMarker, markedBytes],
			);
		}
	}

	private async rollback(
		input: MutationInput,
		backupPath: string,
		cause: unknown,
		ownedStates: Buffer[],
	): Promise<void> {
		try {
			const backup = await this.fs.readFile(backupPath);
			const current = await this.fs.readFile(input.file.hostPath);
			if (!ownedStates.some((owned) => owned.equals(current))) {
				throw new SessionFileEditorError(
					"SESSION_ROLLBACK_CONFLICT",
					"Session file changed during reload; automatic rollback was refused",
					{
						cause,
						backupPath,
						details: {
							originalError: cause instanceof Error ? cause.message : String(cause),
						},
					},
				);
			}
			await this.atomicReplace(input.file.hostPath, backup, backupPath, current);
		} catch (rollbackError) {
			if (
				rollbackError instanceof SessionFileEditorError &&
				rollbackError.code === "SESSION_ROLLBACK_CONFLICT"
			) throw rollbackError;
			if (
				rollbackError instanceof SessionFileEditorError &&
				rollbackError.code === "SESSION_FILE_CHANGED"
			) {
				throw new SessionFileEditorError(
					"SESSION_ROLLBACK_CONFLICT",
					"Session file changed while rollback was being committed",
					{
						cause: new AggregateError([cause, rollbackError]),
						backupPath,
						details: {
							originalError: cause instanceof Error ? cause.message : String(cause),
							rollbackError: rollbackError.message,
						},
					},
				);
			}
			throw new SessionFileEditorError(
				"SESSION_ROLLBACK_FAILED",
				"Session file rollback failed",
				{
					cause: new AggregateError([cause, rollbackError]),
					backupPath,
					details: {
						originalError: cause instanceof Error ? cause.message : String(cause),
						rollbackError: rollbackError instanceof Error
							? rollbackError.message
							: String(rollbackError),
					},
				},
			);
		}

		try {
			const backup = await this.fs.readFile(backupPath);
			await this.reloadWithMarker(input.file, input.reload, backup);
		} catch (rollbackReloadError) {
			throw new SessionFileEditorError(
				"SESSION_ROLLBACK_RELOAD_FAILED",
				"Session file was restored but the runtime could not reload it",
				{
					cause: rollbackReloadError,
					backupPath,
					details: {
						originalError: cause instanceof Error ? cause.message : String(cause),
					},
				},
			);
		}
	}
}

function inputRole(entry: JsonlEntry): string | undefined {
	return typeof messageOf(entry)?.role === "string"
		? String(messageOf(entry)?.role)
		: undefined;
}
