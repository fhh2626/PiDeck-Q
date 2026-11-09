/**
 * pi 内建子代理（pi-subagents 扩展派生的子会话）运行状态投影。
 *
 * 这些子会话由 pi 进程自己创建（前台在父进程内联、后台由扩展 detached 拉起），
 * 不是 PiDeck 的 Agent，因此没有 agentId/runtimeGeneration，`sessionRuntimeByIdAtom`
 * 里也永远不会有它们的快照。唯一可靠的信号是父会话 `subagent` 工具事件的 details
 * （`results[].sessionFile` + `progress.status`），由主进程截取后按会话文件路径下发。
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
