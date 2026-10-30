/**
 * pi 内建子代理（pi-subagents 扩展派生的子会话）运行状态投影。
 *
 * 这些子会话由 pi 进程自己创建（前台在父进程内联、后台由扩展 detached 拉起），
 * 不是 PiDeck 的 Agent，因此没有 agentId/runtimeGeneration，`sessionRuntimeByIdAtom`
 * 里也永远不会有它们的快照。唯一可靠的信号是父会话 `subagent` 工具事件的 details
 * （`results[].sessionFile` + `progress.status`），由主进程截取后按会话文件路径下发。
 */
export type SubagentLiveRunStatus = "running" | "error" | "completed";

export type SubagentLiveRun = {
	/** 子会话文件绝对路径（pi-subagents 的 sessionFile，含 fork 布局）。 */
	sessionFile: string;
	status: SubagentLiveRunStatus;
	/** 子代理角色名（readonly / writable / 自定义），仅用于展示与排障。 */
	agent?: string;
	/**
	 * 最近一次观察到的时间戳；同状态刷新不触发渲染层更新。
	 * completed 条目的 updatedAt 是结束时刻：侧栏行可能在子代理结束后才被扫描出来
	 * （会话文件结束时才落盘，列表刷新在父回答结束后），短暂保留让迟到的行也能匹配到。
	 */
	updatedAt: number;
};

/** 单个 agent 的子代理运行快照：整表替换，渲染层按路径匹配子会话行。 */
export type SubagentLiveSnapshot = {
	agentId: string;
	/** 包含 running / error / 短暂保留的 completed；过期的 completed 不出现。 */
	runs: SubagentLiveRun[];
};
