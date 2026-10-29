import { useCallback, useEffect, useMemo } from "react";
import { useAtom } from "jotai";
import { useTimelinePresentationContext } from "../timeline/timelinePresentationContext";
import { getRunExecutionAtom, type RunExecutionPresentation } from "../../../atoms/timeline-presentation";

export type TurnExecutionState = {
	/** 思考/工具/中间回答步骤是否可见（run 级唯一折叠开关）。 */
	stepsVisible: boolean;
	/** 用户意图：设为指定开合态（勿用「toggle + Radix onOpenChange」以免连点/回调把状态打反）。 */
	setStepsVisibleFromUser: (open: boolean) => void;
	toggleSteps: () => void;
};

/**
 * run 级执行过程折叠状态（一个开关控制全部思考/工具/中间回答步骤）。
 * 遵循计划步骤 6 明确设计：
 * - 引入显式 initialized 状态，首次根据入参规则初始化；
 * - 严禁使用 storedValue || defaultValue，避免显式收起的 false 被默认 true 覆盖；
 * - toggleSteps 反转当前有效 stepsVisible。
 */
export function useTurnExecution(opts: {
	agentRunning?: boolean;
	isComplete: boolean;
	/** 本轮是否存在最终回答：无最终回答的 run 不自动收起。 */
	hasFinalAnswer?: boolean;
	/** 是否时间线上最新一轮。非最新轮不自动收起。 */
	isLatestRun?: boolean;
	/** 设置①：流式对话时展开中间过程。默认关。 */
	expandInterimDuringStream?: boolean;
	/** 设置②：新一轮开始时收起上一轮。默认开。 */
	collapsePrevRunsOnNewTurn?: boolean;
	/** 新一轮开始信号（session 级单调递增）。变化时非最新轮被强制收起。 */
	newTurnCollapseTick?: number;
}): TurnExecutionState {
	const context = useTimelinePresentationContext();
	const presentationAtom = useMemo(() => {
		if (context?.sessionId && context?.rowKey) {
			return getRunExecutionAtom(context.sessionId, context.rowKey);
		}
		return null;
	}, [context?.sessionId, context?.rowKey]);

	const [atomState, setAtomState] = useAtom(
		presentationAtom ??
			useMemo(
				() =>
					getRunExecutionAtom("__local__", "__local__"),
				[],
			),
	);

	// 初始默认值（历史已完成且有最终回答的轮：始终折叠；流式中按 expandInterimDuringStream 展开）
	const initialStepsVisible = useMemo(() => {
		if (opts.isComplete && !opts.agentRunning && opts.hasFinalAnswer) return false;
		return Boolean(opts.expandInterimDuringStream);
	}, [opts.isComplete, opts.agentRunning, opts.hasFinalAnswer, opts.expandInterimDuringStream]);

	// 首次挂载初始化（显式状态转移，禁止逻辑或兜底）
	useEffect(() => {
		if (!atomState.initialized) {
			setAtomState((prev) => {
				if (prev.initialized) return prev;
				return {
					...prev,
					initialized: true,
					stepsVisible: initialStepsVisible,
					wasRunning: Boolean(opts.agentRunning),
				};
			});
		}
	}, [atomState.initialized, initialStepsVisible, opts.agentRunning, setAtomState]);

	// 当前有效 stepsVisible
	const effectiveStepsVisible = atomState.initialized ? atomState.stepsVisible : initialStepsVisible;

	// 仅在「开始跑」上升沿按设置①展开
	useEffect(() => {
		const running = Boolean(opts.agentRunning);
		if (running && !atomState.wasRunning && !atomState.userOverride) {
			if (opts.expandInterimDuringStream) {
				setAtomState((prev) => ({
					...prev,
					initialized: true,
					stepsVisible: true,
					wasRunning: true,
				}));
				return;
			}
		}
		if (running !== atomState.wasRunning) {
			setAtomState((prev) => ({ ...prev, wasRunning: running }));
		}
	}, [opts.agentRunning, atomState.wasRunning, atomState.userOverride, opts.expandInterimDuringStream, setAtomState]);

	// 自动收起：以「agent 已停」为准，1.5s 后收起
	useEffect(() => {
		if (opts.agentRunning || atomState.userOverride) return;
		if (!opts.hasFinalAnswer) return;
		if (opts.isLatestRun === false) return;
		const timer = window.setTimeout(() => {
			setAtomState((prev) => {
				if (prev.userOverride) return prev;
				return { ...prev, initialized: true, stepsVisible: false };
			});
		}, 1500);
		return () => window.clearTimeout(timer);
	}, [opts.agentRunning, atomState.userOverride, opts.hasFinalAnswer, opts.isLatestRun, setAtomState]);

	// 新一轮信号：collapsePrevRunsOnNewTurn 开启时，非最新轮强制收起
	useEffect(() => {
		if (!opts.collapsePrevRunsOnNewTurn) return;
		const tick = opts.newTurnCollapseTick ?? 0;
		if (opts.isLatestRun === false && tick > 0 && tick !== atomState.lastCollapseTick) {
			setAtomState((prev) => ({
				...prev,
				initialized: true,
				userOverride: false,
				stepsVisible: false,
				lastCollapseTick: tick,
			}));
		}
	}, [opts.collapsePrevRunsOnNewTurn, opts.isLatestRun, opts.newTurnCollapseTick, atomState.lastCollapseTick, setAtomState]);

	const setStepsVisibleFromUser = useCallback(
		(open: boolean) => {
			setAtomState((prev) => ({
				...prev,
				initialized: true,
				userOverride: true,
				stepsVisible: open,
			}));
		},
		[setAtomState],
	);

	const toggleSteps = useCallback(() => {
		setAtomState((prev) => ({
			...prev,
			initialized: true,
			userOverride: true,
			stepsVisible: !effectiveStepsVisible,
		}));
	}, [setAtomState, effectiveStepsVisible]);

	return { stepsVisible: effectiveStepsVisible, setStepsVisibleFromUser, toggleSteps };
}
