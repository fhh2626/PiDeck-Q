/**
 * webApi — Web 端与主进程 WebServiceManager 的 HTTP 数据访问层。
 *
 * 覆盖范围（与桌面端对齐但收窄）：
 * - /api/state：项目/会话/运行态轮询
 * - /api/sessions（POST）：按项目新建会话
 * - /api/sessions/:id/messages/page：历史消息分页
 * - 发送消息走 useChat（/api/chat 流式），不在此处重复实现
 */
import type { UIMessage } from "ai";
import type {
	AvailableModel,
	AskQuestionResultSummary,
	ChatMessage,
	ContextControllerState,
	ImageContent,
	SendSessionPromptResult,
	SessionCommandResult,
	SessionLaunchPreferences,
	SessionMessagePage,
	SessionRuntimeTarget,
	SessionTargetedValue,
	UpdateSessionRecordInput,
} from "../../../shared/types";
import {
	getAskQuestionResultFromMessage,
	normalizeAskQuestionResultSummary,
} from "../../../shared/askQuestion";
import type { WebState } from "./webTypes";

/** 轮询 /api/state 拿项目/会话/运行态（低频兜底，主数据流走 useChat）。 */
export async function fetchState(): Promise<WebState> {
	const res = await fetch("/api/state");
	if (!res.ok) throw new Error(`state ${res.status}`);
	return res.json();
}

/** 从 Web 端注册一个本地项目路径，返回项目记录。 */
export async function createProject(path: string): Promise<WebState["projects"][number]> {
	const res = await fetch("/api/projects", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path }),
	});
	if (!res.ok) throw new Error(`create project ${res.status}`);
	const result = (await res.json()) as { project?: WebState["projects"][number] };
	if (!result.project) throw new Error("create project: missing project");
	return result.project;
}

/** 删除项目登记记录；不会删除项目目录或工作区文件。 */
export async function deleteProject(projectId: string): Promise<void> {
	const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/delete`, { method: "POST" });
	if (!res.ok) throw new Error(`delete project ${res.status}`);
}

/** 读取 pi 当前可用模型，草稿会话也可以先选模型再发送第一条消息。 */
export async function fetchModels(): Promise<AvailableModel[]> {
	const res = await fetch("/api/models");
	if (!res.ok) throw new Error(`models ${res.status}`);
	const result = (await res.json()) as { models?: AvailableModel[] };
	return result.models ?? [];
}

/** 读取会话 JSONL 中最后一条上下文控制器快照；与桌面 IPC 同源。 */
export async function fetchContextControllerState(sessionId: string): Promise<ContextControllerState> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-controller-state`);
	if (!res.ok) throw new Error(`context-controller-state ${res.status}`);
	return res.json() as Promise<ContextControllerState>;
}

/**
 * 静默下发上下文开关命令。不走 /prompt，避免占用 Web 生成锁。
 * 桌面与 Web 最终都进入同一条 sendSessionPrompt(silent) 路径，JSONL 快照共享。
 */
export async function sendContextControllerCommand(
	sessionId: string,
	command: string,
): Promise<SendSessionPromptResult> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-controller`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ command }),
	});
	if (!res.ok) throw new Error(`context-controller ${res.status}`);
	const payload = (await res.json()) as { result?: SendSessionPromptResult };
	if (!payload.result) throw new Error("context-controller: missing result");
	return payload.result;
}

/** 按项目新建会话（对应桌面端「新建 Agent」入口）。返回新会话 id。 */
/**
 * 新建会话草稿；preferences 携带启动前选择的模型/思考级别（首页直发场景），
 * 无偏好时保持后端默认（pi 配置默认值）。
 */
export async function createSession(
	projectId: string,
	preferences?: SessionLaunchPreferences,
): Promise<string> {
	const res = await fetch("/api/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId, ...preferences }),
	});
	if (!res.ok) throw new Error(`create session ${res.status}`);
	const result = (await res.json()) as { session?: { id?: string } };
	const id = result.session?.id;
	if (!id) throw new Error("create session: missing session id");
	return id;
}

/** 拉历史消息页（分页），供注入 useChat / 展示。 */
/** 更新尚未启动 runtime 的会话偏好；运行中的会话由 runtime 命令即时应用。 */
export async function updateSessionRecord(
	sessionId: string,
	patch: UpdateSessionRecordInput,
): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/update`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) throw new Error(`update session ${res.status}`);
}

async function callRuntimeCommand<T>(
	sessionId: string,
	target: SessionRuntimeTarget,
	action: string,
	body: Record<string, unknown> = {},
): Promise<T> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runtime/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target, ...body }),
	});
	if (!res.ok) throw new Error(`runtime ${action} ${res.status}`);
	const payload = (await res.json()) as { result?: SessionCommandResult<SessionTargetedValue<T>> };
	const result = payload.result;
	if (!result || !result.ok) {
		throw new Error(result?.error.code ?? `runtime ${action} failed`);
	}
	return result.value.value;
}

/** 运行中的模型切换会立即发送给 pi，并由主进程同步会话记录。 */
export function setRuntimeModel(
	target: SessionRuntimeTarget,
	provider: string,
	modelId: string,
): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "model", { provider, modelId });
}

/** 运行中的思考级别切换会立即发送给 pi，并由主进程同步会话记录。 */
export function setRuntimeThinking(
	target: SessionRuntimeTarget,
	level: string,
): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "thinking", { level });
}

/** 中止当前 Session 的运行时，而不是只关掉 Web 前端的 SSE。 */
export function abortRuntime(target: SessionRuntimeTarget): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "abort");
}

export async function fetchMessagePage(
	sessionId: string,
	before?: number,
	pageSize?: number,
): Promise<SessionMessagePage> {
	const params = new URLSearchParams();
	if (before != null) params.set("before", String(before));
	if (pageSize != null) params.set("pageSize", String(pageSize));
	const qs = params.toString();
	const res = await fetch(
		`/api/sessions/${encodeURIComponent(sessionId)}/messages/page${qs ? `?${qs}` : ""}`,
	);
	if (!res.ok) throw new Error(`messages ${res.status}`);
	return (await res.json()) as SessionMessagePage;
}

type WebMessageMetadata = {
	/** 原始 ChatMessage 角色；UIMessage 只能表达 user/assistant/system。 */
	chatRole: ChatMessage["role"];
	/** 用于把历史页与运行时快照放回同一时间线。 */
	timestamp?: number;
	/** Pi 活动分支条目身份；运行时/历史投影都可能携带。 */
	entryId?: string;
	/** 工具结果的跨投影稳定身份；工具文本会随执行状态改变，不能用文本匹配。 */
	toolCallId?: string;
	/** 已完成的 ask_question 结果（规范化后）；存在时 Web 时间线渲染常驻问答卡。 */
	askQuestionResult?: AskQuestionResultSummary;
};

function createWebMessageMetadata(message: ChatMessage): WebMessageMetadata {
	const metadata: WebMessageMetadata = {
		chatRole: message.role,
		timestamp: message.timestamp,
	};
	const entryId = message.meta?.entryId;
	if (typeof entryId === "string" && entryId) metadata.entryId = entryId;
	const toolCallId = message.meta?.toolCallId;
	if (typeof toolCallId === "string" && toolCallId) metadata.toolCallId = toolCallId;
	// 主进程投影把 ask_question 结果挂在 meta._askCard；这里规范化后随
	// UIMessage.metadata 下发，Web 时间线据此渲染常驻问答卡（与桌面一致）。
	const askResult = getAskQuestionResultFromMessage(message);
	if (askResult) metadata.askQuestionResult = askResult;
	return metadata;
}

function parseWebToolInput(value: unknown): unknown {
	if (typeof value !== "string") return value ?? {};
	if (!value.trim()) return {};
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function getWebToolName(message: ChatMessage): string {
	const fromMeta = message.meta?.toolName;
	if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim();
	const label = message.text.replace(/^[▶✓✗]\s*/u, "").trim();
	return label.split(/\s+/u)[0] || "tool";
}

function createWebToolPart(message: ChatMessage): UIMessage["parts"][number] {
	const meta = message.meta;
	const toolName = getWebToolName(message);
	const toolCallId = typeof meta?.toolCallId === "string" && meta.toolCallId.trim()
		? meta.toolCallId
		: message.id;
	const input = parseWebToolInput(meta?.args);
	const detail = meta?.detailText ?? meta?.result ?? message.text;
	const isError = meta?.status === "error" || meta?.isError === true;

	if (meta?.status === "running") {
		return {
			type: "dynamic-tool",
			toolName,
			toolCallId,
			state: "input-available",
			input,
		};
	}
	if (isError) {
		return {
			type: "dynamic-tool",
			toolName,
			toolCallId,
			state: "output-error",
			input,
			errorText: typeof detail === "string" ? detail : message.text,
		};
	}
	return {
		type: "dynamic-tool",
		toolName,
		toolCallId,
		state: "output-available",
		input,
		output: detail,
	};
}

const WEB_IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp)$/i;
const MAX_WEB_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;

/** 将持久化图片转换为受限 data URL，拒绝任意外部 URL 和过大的 payload。 */
function createWebImagePart(image: ImageContent): UIMessage["parts"][number] | undefined {
	const mimeType = image.mimeType.trim().toLowerCase();
	const data = image.data.trim();
	if (
		!WEB_IMAGE_MIME.test(mimeType) ||
		!data ||
		data.length > MAX_WEB_IMAGE_BASE64_LENGTH ||
		!/^[a-z0-9+/]+={0,2}$/i.test(data)
	) return undefined;
	return {
		type: "file",
		mediaType: mimeType,
		url: `data:${mimeType};base64,${data}`,
	};
}

/**
 * 历史 ChatMessage 列表 → useChat 的 UIMessage[]（text-only parts）。
 * 历史消息仅注入正文；流式思考/工具由 useChat 从 SSE 实时构建，避免与
 * 静态历史重复。ChatMessage.thinking 存在时一并注入 reasoning part，
 * 让历史会话也能折叠查看思考过程。保留少量非展示元数据，供历史页与
 * 运行时快照合并时识别同一条工具/会话条目，避免把状态更新的工具追加到末尾。
 */
export function chatMessagesToUiMessages(messages: ChatMessage[]): UIMessage[] {
	return messages.map((message) => {
		const role =
			message.role === "user"
				? "user"
				: message.role === "assistant"
					? "assistant"
					: "assistant";
		const parts: UIMessage["parts"] = [];
		if (message.role === "tool") {
			parts.push(createWebToolPart(message));
		} else {
			if (message.thinking) {
				parts.push({ type: "reasoning", text: message.thinking });
			}
			if (message.text) {
				parts.push({ type: "text", text: message.text });
			}
			for (const image of message.images ?? []) {
				const part = createWebImagePart(image);
				if (part) parts.push(part);
			}
		}
		return {
			id: message.id ?? `hist-${message.timestamp ?? Math.random()}`,
			role,
			metadata: createWebMessageMetadata(message),
			parts,
		};
	});
}

function readWebMessageMetadata(message: UIMessage): WebMessageMetadata | undefined {
	const value = message.metadata;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const chatRole = Reflect.get(value, "chatRole");
	if (chatRole !== "user" && chatRole !== "assistant" && chatRole !== "tool" && chatRole !== "system" && chatRole !== "error") {
		return undefined;
	}
	const timestamp = Reflect.get(value, "timestamp");
	const entryId = Reflect.get(value, "entryId");
	const toolCallId = Reflect.get(value, "toolCallId");
	const askQuestionResult = normalizeAskQuestionResultSummary(
		Reflect.get(value, "askQuestionResult"),
	);
	return {
		chatRole,
		...(typeof timestamp === "number" ? { timestamp } : {}),
		...(typeof entryId === "string" && entryId ? { entryId } : {}),
		...(typeof toolCallId === "string" && toolCallId ? { toolCallId } : {}),
		...(askQuestionResult ? { askQuestionResult } : {}),
	};
}

/**
 * 从 UIMessage 读取已完成的 ask_question 结果。
 * 结果在 createWebMessageMetadata 时已规范化并挂在 metadata 上，
 * 这里再走一次 normalizeAskQuestionResultSummary 兜底（SSE 占位合并 /
 * 旧缓存），保证 Web 时间线拿到的一定是规范结构，损坏时返回 undefined。
 */
export function getWebAskQuestionResult(
	message: UIMessage,
): AskQuestionResultSummary | undefined {
	const raw = readWebMessageMetadata(message)?.askQuestionResult;
	if (!raw || typeof raw !== "object") return undefined;
	return normalizeAskQuestionResultSummary(raw);
}

function uiMessageRole(message: UIMessage): ChatMessage["role"] {
	return readWebMessageMetadata(message)?.chatRole ?? (message.role === "user" ? "user" : "assistant");
}

function uiMessageIdentity(message: UIMessage): string | undefined {
	const metadata = readWebMessageMetadata(message);
	if (!metadata) return undefined;
	if (metadata.chatRole === "tool" && metadata.toolCallId) return `tool:${metadata.toolCallId}`;
	if (metadata.entryId) return `${metadata.chatRole}:entry:${metadata.entryId}`;
	return undefined;
}

function findTimestampInsertionIndex(messages: UIMessage[], incoming: UIMessage): number {
	const timestamp = readWebMessageMetadata(incoming)?.timestamp;
	if (timestamp === undefined) return messages.length;
	let firstLaterIndex = messages.length;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidateTimestamp = readWebMessageMetadata(messages[index])?.timestamp;
		if (candidateTimestamp === undefined) continue;
		if (candidateTimestamp <= timestamp) return index + 1;
		firstLaterIndex = index;
	}
	return firstLaterIndex;
}

function uiMessageText(message: UIMessage): string {
	return message.parts
		.map((part) => {
			if (part.type === "text" || part.type === "reasoning") return part.text;
			return "";
		})
		.join("");
}

function sameUiMessage(left: UIMessage, right: UIMessage): boolean {
	return left.id === right.id
		&& left.role === right.role
		&& JSON.stringify(left.parts) === JSON.stringify(right.parts)
		// metadata 也要比：ask_question 完成后快照只追加 metadata.askQuestionResult
		// （parts 不变），只比 parts 会让「只变 metadata」的更新被误判为相同而跳过替换，
		// Web 端看不到常驻问答卡。
		&& JSON.stringify(left.metadata ?? null) === JSON.stringify(right.metadata ?? null);
}

function isEmptyUiMessage(message: UIMessage): boolean {
	return uiMessageText(message).trim().length === 0
		&& !message.parts.some((part) => part.type !== "text" && part.type !== "reasoning");
}

function isLocalOnlyAssistantPlaceholder(message: UIMessage): boolean {
	if (uiMessageRole(message) !== "assistant") return false;
	if (readWebMessageMetadata(message)) return false;
	const hasVisibleText = message.parts.some((part) => part.type === "text" && part.text.trim());
	if (hasVisibleText) return false;
	return message.parts.some((part) =>
		part.type === "reasoning"
		|| part.type === "dynamic-tool"
		|| (typeof part.type === "string" && part.type.startsWith("tool-")),
	);
}

function leftoverPlaceholderToolIds(message: UIMessage): string[] {
	return message.parts.flatMap((part) => {
		if (
			part.type !== "dynamic-tool"
			&& !(typeof part.type === "string" && part.type.startsWith("tool-"))
		) return [];
		const toolCallId = Reflect.get(part, "toolCallId");
		return typeof toolCallId === "string" && toolCallId ? [toolCallId] : [];
	});
}

function leftoverReasoningText(message: UIMessage): string {
	return message.parts
		.filter((part) => part.type === "reasoning")
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n");
}

function leftoverVisibleText(message: UIMessage): string {
	return message.parts
		.filter((part) => part.type === "text")
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n");
}

function isLocalSseAssistant(message: UIMessage): boolean {
	return uiMessageRole(message) === "assistant" && !readWebMessageMetadata(message);
}

/** 直播合泡（思考+工具/正文）不能按拼接文本去对单条快照，否则会被思考前缀整段替换。 */
function isCombinedLocalSseAssistant(message: UIMessage): boolean {
	if (!isLocalSseAssistant(message)) return false;
	const hasReasoning = leftoverReasoningText(message).length > 0;
	const hasTool = leftoverPlaceholderToolIds(message).length > 0;
	const hasText = leftoverVisibleText(message).length > 0;
	return (hasReasoning && hasText) || (hasReasoning && hasTool) || (hasTool && hasText);
}

function hasVisibleAssistantText(message: UIMessage): boolean {
	return message.parts.some((part) => part.type === "text" && part.text.trim());
}

/** 快照已经落到最终正文后，本地思考/工具占位才是可以清掉的孤儿。 */
function snapshotHasSettledAssistant(authoritative: UIMessage[]): boolean {
	return authoritative.some((message) =>
		uiMessageRole(message) === "assistant" && hasVisibleAssistantText(message),
	);
}

/** 权威快照已经包含同一段思考/同一工具/同一正文时，本地 SSE 气泡才是重复的队尾锁。 */
function isCoveredLocalSseAssistant(leftover: UIMessage, authoritative: UIMessage[]): boolean {
	if (!isLocalSseAssistant(leftover)) return false;
	const leftoverText = leftoverReasoningText(leftover);
	const leftoverToolIds = leftoverPlaceholderToolIds(leftover);
	const leftoverAnswer = leftoverVisibleText(leftover);
	return authoritative.some((incoming) => {
		if (leftoverText) {
			const incomingText = leftoverReasoningText(incoming);
			if (
				incomingText
				&& (incomingText === leftoverText
					|| incomingText.startsWith(leftoverText)
					|| leftoverText.startsWith(incomingText))
			) return true;
		}
		if (leftoverToolIds.length > 0) {
			const incomingIdentity = uiMessageIdentity(incoming);
			if (incomingIdentity && leftoverToolIds.some((id) => incomingIdentity === `tool:${id}`)) {
				return true;
			}
			if (leftoverPlaceholderToolIds(incoming).some((id) => leftoverToolIds.includes(id))) {
				return true;
			}
		}
		if (leftoverAnswer) {
			const incomingAnswer = leftoverVisibleText(incoming);
			if (
				incomingAnswer
				&& (incomingAnswer === leftoverAnswer
					|| incomingAnswer.startsWith(leftoverAnswer)
					|| leftoverAnswer.startsWith(incomingAnswer))
			) return true;
		}
		return false;
	});
}

/**
 * 只把「局部文本 → 完整文本」用在助手回复上。用户消息即便正文相同，
 * 也必须靠稳定 id / entryId 对齐；前缀匹配会把空的本地乐观气泡、
 * 以及「继续」「好」这类短句误判成同一条。
 */
function canMatchPartialText(role: ChatMessage["role"]): boolean {
	return role === "assistant" || role === "tool" || role === "system" || role === "error";
}

/**
 * 用主进程运行时快照补偿 Web 本地 useChat 缓存。
 *
 * Web 自己生成的 user/assistant id 与 pi 落盘 id 不同，因此先按稳定 id 匹配，
 * 再按角色与文本（含“局部文本 → 完整文本”）匹配，避免 PC 端消息轮询到 Web 后
 * 变成重复气泡。快照只覆盖运行期尾部，未包含的旧消息保留给历史分页缓存。
 */
export function mergeAuthoritativeUiMessages(
	current: UIMessage[],
	authoritative: UIMessage[],
	options?: { dropUnmatchedTrailingPlaceholders?: boolean },
): UIMessage[] {
	if (authoritative.length === 0) return current;
	const merged = [...current];
	const matchedCurrent = new Set<number>();
	let changed = false;
	// 权威快照是时间顺序。本地 useChat 消息通常没有 timestamp，
	// 漏掉的旧回复如果按时间戳插入会落到末尾，表现为“上一条没回、下一条回了两次”。
	let lastPlacedIndex = -1;

	for (const incoming of authoritative) {
		let matchIndex = -1;
		for (let index = 0; index < merged.length; index += 1) {
			if (!matchedCurrent.has(index) && merged[index].id === incoming.id) {
				matchIndex = index;
				break;
			}
		}

		const incomingIdentity = uiMessageIdentity(incoming);
		if (matchIndex < 0 && incomingIdentity) {
			for (let index = 0; index < merged.length; index += 1) {
				if (
					!matchedCurrent.has(index)
					&& uiMessageIdentity(merged[index]) === incomingIdentity
				) {
					matchIndex = index;
					break;
				}
			}
		}

		const incomingText = uiMessageText(incoming);
		const incomingRole = uiMessageRole(incoming);
		if (matchIndex < 0) {
			for (let index = merged.length - 1; index >= 0; index -= 1) {
				const candidate = merged[index];
				if (
					matchedCurrent.has(index)
					|| uiMessageRole(candidate) !== incomingRole
					|| uiMessageText(candidate) !== incomingText
				) continue;
				matchIndex = index;
				break;
			}
		}

		// 流式缓存可能只保留了前缀，而轮询快照已经拿到完整正文。
		if (matchIndex < 0 && incomingText && canMatchPartialText(incomingRole)) {
			for (let index = merged.length - 1; index >= 0; index -= 1) {
				const candidateText = uiMessageText(merged[index]);
				if (
					matchedCurrent.has(index)
					|| uiMessageRole(merged[index]) !== incomingRole
					|| !candidateText
					|| isLocalOnlyAssistantPlaceholder(merged[index])
					|| isCombinedLocalSseAssistant(merged[index])
					|| !(incomingText.startsWith(candidateText) || candidateText.startsWith(incomingText))
				) continue;
				matchIndex = index;
				break;
			}
		}

		if (matchIndex >= 0) {
			// 缓存自身可能已被早先一次增量合并排乱，例如最终正文留在思考卡之前。
			// 仅替换命中的内容无法自愈；当命中项落在上一条权威消息之前时，
			// 必须把它移动到上一条之后，保证重连后严格恢复权威时间线顺序。
			if (matchIndex < lastPlacedIndex) {
				merged.splice(matchIndex, 1);
				const shiftedAfterRemoval = [...matchedCurrent].map((index) =>
					index > matchIndex ? index - 1 : index,
				);
				matchedCurrent.clear();
				for (const index of shiftedAfterRemoval) matchedCurrent.add(index);
				lastPlacedIndex -= 1;

				const insertionIndex = lastPlacedIndex + 1;
				const shiftedAfterInsertion = [...matchedCurrent].map((index) =>
					index >= insertionIndex ? index + 1 : index,
				);
				matchedCurrent.clear();
				for (const index of shiftedAfterInsertion) matchedCurrent.add(index);
				merged.splice(insertionIndex, 0, incoming);
				matchedCurrent.add(insertionIndex);
				lastPlacedIndex = insertionIndex;
				changed = true;
				continue;
			}
			matchedCurrent.add(matchIndex);
			if (!sameUiMessage(merged[matchIndex], incoming)) {
				merged[matchIndex] = incoming;
				changed = true;
			}
			lastPlacedIndex = matchIndex;
			continue;
		}

		const insertionIndex = lastPlacedIndex >= 0
			? lastPlacedIndex + 1
			: findTimestampInsertionIndex(merged, incoming);
		// matchedCurrent tracks indexes in the mutable merged array. Inserting before
		// an already matched item shifts its index, so update the set before marking
		// the newly inserted message as consumed.
		if (insertionIndex < merged.length) {
			const shifted = [...matchedCurrent]
				.filter((index) => index >= insertionIndex)
				.map((index) => index + 1);
			for (const index of [...matchedCurrent]) {
				if (index >= insertionIndex) matchedCurrent.delete(index);
			}
			for (const index of shifted) matchedCurrent.add(index);
		}
		merged.splice(insertionIndex, 0, incoming);
		matchedCurrent.add(insertionIndex);
		lastPlacedIndex = insertionIndex;
		changed = true;
	}

	// useChat 会先插入一条尚无正文的本地 user 气泡。若权威快照已经带上了
	// 同一轮用户消息，这条空气泡必须丢掉，否则时间线上会出现两条用户消息。
	const canDropUnmatchedPlaceholders =
		options?.dropUnmatchedTrailingPlaceholders === true
		&& snapshotHasSettledAssistant(authoritative);
	for (let index = merged.length - 1; index >= 0; index -= 1) {
		if (matchedCurrent.has(index)) continue;
		const leftover = merged[index];
		const dropEmptyUser = uiMessageRole(leftover) === "user" && isEmptyUiMessage(leftover);
		const covered = isCoveredLocalSseAssistant(leftover, authoritative);
		// 流式：只删快照已覆盖的无字占位。
		// 空闲且快照已有最终正文：清掉未匹配的本地思考/工具占位，以及已被快照覆盖的带字 SSE 合泡。
		const dropPlaceholder = isLocalOnlyAssistantPlaceholder(leftover) && (
			covered
			|| canDropUnmatchedPlaceholders
		);
		const dropCoveredSseWithText = canDropUnmatchedPlaceholders && covered && isLocalSseAssistant(leftover);
		if (!dropEmptyUser && !dropPlaceholder && !dropCoveredSseWithText) continue;
		merged.splice(index, 1);
		changed = true;
	}

	return changed ? merged : current;
}

/** 手机/Web 端回答 ask_question / confirm / input。 */
export async function respondToUi(input: {
	sessionId: string;
	requestId: string;
	agentId: string;
	runtimeGeneration: number;
	response: import("../../../shared/types").AgentUiResponse;
}): Promise<void> {
	const res = await fetch("/api/ui-response", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) throw new Error(`ui-response ${res.status}`);
}
