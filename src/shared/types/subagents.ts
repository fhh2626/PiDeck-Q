/**
 * pi 内建子代理（pi-subagents 扩展派生的子会话）运行状态投影。
 *
 * 这些子会话由 pi 进程自己创建（前台在父进程内联、后台由扩展 detached 拉起），
 * 不是 PiDeck 的 Agent，因此没有 agentId/runtimeGeneration，`sessionRuntimeByIdAtom`
 * 里也永远不会有它们的快照。信号来自父会话工具 details 与交接后的扩展状态槽，
 * 主进程按执行身份仲裁新旧来源，再按会话文件路径下发最小状态。
 */

/**
 * 下发给渲染层的子代理状态：只有 running / error。
 *
 * completed 是「观察阶段」的终态（终态帧到达时得到），到达即移除，不进入投影：
 * 侧栏黄点的语义是「正在运行」，结束后继续亮灯会被读成「已经停了还在跑」。
 */
export type SubagentLiveRunStatus = "running" | "error";

export type SubagentLiveRun = {
	/** 子会话文件绝对路径（pi-subagents 的 sessionFile，含 fork 布局）。 */
	sessionFile: string;
	status: SubagentLiveRunStatus;
	/** 子代理角色名（readonly / writable / 自定义），仅用于展示与排障。 */
	agent?: string;
	/** 最近一次观察到的时间戳；同状态刷新不触发渲染层更新。 */
	updatedAt: number;
};

/** 单个 agent 的子代理运行快照：整表替换，渲染层按路径匹配子会话行。 */
export type SubagentLiveSnapshot = {
	agentId: string;
	/** 只含 running / error；终态 completed 不会出现在下发快照里。 */
	runs: SubagentLiveRun[];
};

// ── 子代理状态快照通道（扩展 → 桌面宿主） ─────────────────────────────
// 前台 workflow 在子代理提问时会把工具调用先返回给父会话（交接），之后继续执行
// 却不能再往那个工具调用发进度帧，侧栏因此看不到「回答后继续跑」的子代理。
// 扩展改为把最小运行态投影到 pi 的扩展状态槽（ctx.ui.setStatus），主进程按 key
// 前缀消费；不新增网络通道，也不往会话历史写消息。

/** 状态槽 key 前缀；完整 key 为 `${前缀}${workflowRunId}`，并发任务各占一槽。 */
export const SUBAGENT_STATUS_KEY_PREFIX = "pideck.subagent-status.v1:";

export const SUBAGENT_STATUS_SNAPSHOT_VERSION = 1;

/** 扩展侧观察到的子代理状态；比下发状态多终态，用于收灯。 */
export type SubagentStatusChildState =
	| "running"
	| "completed"
	| "failed"
	| "stopped"
	| "paused"
	| "detached";

export type SubagentStatusChild = {
	/** 编排里的任务 key（runs.run 的 key）。 */
	taskKey: string;
	/** 本次实际执行标识（不透明，不按大小排序）；缺省时按 workflow + taskKey 回退。 */
	executionId?: string;
	/** 子会话文件绝对路径，侧栏按它匹配子会话行。 */
	sessionFile: string;
	agent?: string;
	state: SubagentStatusChildState;
};

export type SubagentStatusSnapshot = {
	version: typeof SUBAGENT_STATUS_SNAPSHOT_VERSION;
	/** 父会话文件路径（扩展侧 resolveCurrentSessionId 的结果）。 */
	ownerSessionId: string;
	parentToolCallId: string;
	workflowRunId: string;
	/** 单调递增；主进程据此丢弃乱序或重复帧。 */
	sequence: number;
	/** 任务已结束：主进程清掉该任务全部灯，不再等待后续帧。 */
	complete: boolean;
	/** 条目被裁剪过：不是完整清单，主进程不得据此删除未出现的条目。 */
	truncated: boolean;
	observedAt: number;
	children: SubagentStatusChild[];
};

// ── 子代理偏好设置（右侧工具条「子代理」弹框） ─────────────────────────
// 落盘位置是 pi 的 settings.json `subagents` 块：扩展本来就从这里读
// defaultModel / defaultProvider / defaultThinking，PiDeck 只负责图形化编辑。

/** 配置作用域：全局（~/.pi/agent/settings.json）或当前项目（<project>/.pi/settings.json）。 */
export type SubagentSettingsScope = "global" | "project";

/** 子代理独立模型选择。 */
export type SubagentModelChoice = {
	provider: string;
	modelId: string;
	/** 思考强度；缺省表示不写 defaultThinking，沿用 pi 默认。 */
	thinkingLevel?: string;
};

/** 一份作用域下的子代理偏好。 */
export type SubagentSettings = {
	/** 子代理是否使用与主代理不同的模型；false = 继承主代理。 */
	useOwnModel: boolean;
	/** useOwnModel 为 true 时的模型与档位。 */
	model?: SubagentModelChoice;
	/** 是否在系统提示词中引导主代理优先把复杂任务交给子代理。 */
	preferDelegation: boolean;
};

/** 一次读取返回两个作用域，渲染层切换作用域时无需再请求。 */
export type SubagentSettingsSnapshot = {
	global: SubagentSettings;
	/** 无活动项目时为 null（弹框禁用项目作用域）。 */
	project: SubagentSettings | null;
};
