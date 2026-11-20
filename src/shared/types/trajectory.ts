/**
 * 会话 JSONL 里的非对话过程事件。
 * 时间线只投影 user/assistant/tool；轨迹复盘单独读这些条目，不改聊天渲染。
 */
export type SessionProcessEventKind =
	| "session"
	| "sessionInfo"
	| "modelChange"
	| "thinkingChange"
	| "compaction"
	| "custom"
	| "import";

export type SessionProcessEvent = {
	id: string;
	kind: SessionProcessEventKind;
	timestamp: number;
	summary: string;
	detail?: string;
	/** Path as recorded in the Pi JSONL header, without catalog normalization. */
	cwd?: string;
	/** Parent path as recorded in the Pi JSONL header, without ancestry resolution. */
	parentSession?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	customType?: string;
	tokensBefore?: number;
};
