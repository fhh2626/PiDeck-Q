/**
 * 执行过程正文（思考/工具/中间回答）是否进入 DOM。
 *
 * 为什么不能只看 `stepsVisible`：
 * - 折叠仅靠 `display: none` 隐藏时，节点仍留在文档里；长会话（贴底 50 轮、一轮可含
 *   上百条工具）会让样式重算与布局成本随挂载节点线性增长，表现为输入和拖动都顿一下。
 * - 但正在输出的那一轮必须继续保留隐藏 DOM：打字机进度、思考光标与未结束工具卡的
 *   运行状态都在组件内部，卸载会丢状态并造成二次打印（见 TurnRow 的 live 挂载门注释）。
 *
 * 因此规则是「展开中」或「本轮仍在输出」才挂载正文；已结束且收起的轮次直接卸载，
 * 用户展开时再挂载。`agentRunning` 由时间线只下发给当前忙碌轮，不能拿 `isLatestRun`
 * 代替——最新轮完成后用户并未展开，也必须卸载。
 */
export function shouldMountProcessBody(
	stepsVisible: boolean,
	agentRunning: boolean | undefined,
): boolean {
	return stepsVisible || agentRunning === true;
}
