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
import { readWebMessageMetadata, type WebMessageMetadata } from "./webMessageMetadata";

export { mergeAuthoritativeUiMessages, prependOlderHistoryPage } from "./webMessageMerge";

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

/**
 * 停止指定 Session 的运行时（优雅关闭）。
 *
 * stop 的响应是 SessionCommandResult<SessionRuntimeTarget>：value 直接是 target
 * （见 SessionRuntimeCoordinator.stopRuntime 返回 { ok:true, value: target }），
 * 没有 SessionTargetedValue 那层嵌套，因此不能走 callRuntimeCommand（它读 value.value，
 * 会把成功关闭解析成 undefined）。本函数单独按非嵌套形状解析并核对身份。
 */
export async function stopRuntime(target: SessionRuntimeTarget): Promise<SessionRuntimeTarget> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(target.sessionId)}/runtime/stop`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target }),
	});
	if (!res.ok) throw new Error(`runtime stop ${res.status}`);
	const payload = (await res.json()) as { result?: SessionCommandResult<SessionRuntimeTarget> };
	const result = payload.result;
	if (!result || !result.ok) {
		throw new Error(result?.error.code ?? "runtime stop failed");
	}
	const stopped = result.value;
	// 损坏/串代的成功回包不得当成正常关闭：三元组一致才接受。
	if (
		!stopped ||
		stopped.sessionId !== target.sessionId ||
		stopped.agentId !== target.agentId ||
		stopped.runtimeGeneration !== target.runtimeGeneration
	) {
		throw new Error("runtime stop returned an unexpected target");
	}
	return stopped;
}

/** 删除指定会话记录；会话若处于运行态需先停止才能删除。 */
export async function deleteSession(sessionId: string): Promise<boolean> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, {
		method: "POST",
	});
	if (!res.ok) {
		let message = `delete session ${res.status}`;
		try {
			const body = (await res.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// ignore json parse error
		}
		throw new Error(message);
	}
	const payload = (await res.json()) as { deleted?: boolean };
	if (payload.deleted !== true) {
		throw new Error("delete session failed");
	}
	return true;
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

export function getWebAskQuestionResult(
	message: UIMessage,
): AskQuestionResultSummary | undefined {
	const raw = readWebMessageMetadata(message)?.askQuestionResult;
	if (!raw || typeof raw !== "object") return undefined;
	return normalizeAskQuestionResultSummary(raw);
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
