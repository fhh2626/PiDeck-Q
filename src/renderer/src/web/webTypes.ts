import type { ChatMessage, PendingUiRequestSnapshot } from '../../../shared/types';
/**
 * Web 端（A2 React）状态类型。
 *
 * 与后端 /api/state 返回结构对齐（WebServiceManager.getState），
 * 由 webApi.ts 轮询填充。会话/运行态只读展示用，不持有桌面端 atoms。
 */

export type WebProject = {
	id: string;
	name: string;
	path: string;
	kind?: "chat";
	/** 最近打开时间（毫秒时间戳），Web 端项目列表按此降序展示 */
	lastOpenedAt?: number;
	pinned?: boolean;
	sortOrder?: number;
};

export type WebSession = {
	id: string;
	projectId: string;
	title: string;
	status: string;
	projectPath?: string;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	/** 会话目录里的消息条数；首页失败或游标未到时，用来判断是否还能翻历史。 */
	messageCount?: number;
	/** 最近活动时间（毫秒时间戳），Web 端会话列表按此降序展示（最新在上） */
	updatedAt?: number;
};

export type WebRuntime = {
	sessionId: string;
	agentId: string;
	status: string;
	cwd?: string;
	runtimeGeneration?: number;
	/** /api/state 增量字段；旧服务端可缺省。 */
	isStreaming?: boolean;
	isExecutingTool?: boolean;
};

/**
 * Web 端待回答的 UI 请求快照。直接复用主进程契约（含 batchQuestions/batchReview），
 * /api/state 的 pendingUiRequests 由 SessionRuntimeCoordinator 原样序列化，
 * 两侧共用一份类型，避免字段漂移。
 */
export type WebPendingUiRequest = PendingUiRequestSnapshot;

export type WebState = {
	projects: WebProject[];
	sessions: WebSession[];
	runtimes: WebRuntime[];
	pendingUiRequests?: WebPendingUiRequest[];
	/** 运行中 Session 的主进程消息尾部快照，用于补偿 Web SSE/本地缓存。 */
	messagesBySession: Record<string, ChatMessage[]>;
};
