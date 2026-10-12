/**
 * 输入延迟诊断：用 Event Timing API 观察键盘/输入法/输入事件从发生到下一帧绘制的耗时，
 * 超过阈值时汇总写日志，便于在真实长会话里确认“打字卡”的来源与频率。
 *
 * - 只记录时长与事件类型，不记录按键内容或输入文本；
 * - 慢事件按时间窗聚合，每个窗口最多一条日志，避免卡顿时再被日志拖慢；
 * - 同时汇总窗口内的长任务（longtask），帮助区分“事件处理本身慢”和“主线程被别的工作占住”；
 * - 运行环境不支持对应条目类型时静默不启用。
 */

export type InputLatencySample = {
	name: string;
	durationMs: number;
	inputDelayMs: number;
	processingMs: number;
	presentationDelayMs: number;
};

export type InputLatencyReport = {
	windowMs: number;
	slowEvents: number;
	byType: Record<string, number>;
	worst: InputLatencySample;
	longTasks: number;
	longestTaskMs: number;
	domNodes: number;
};

export type InputLatencyMonitorOptions = {
	report: (report: InputLatencyReport) => void;
	/** 事件总时长（输入到绘制）超过此值算慢，默认 100ms。 */
	thresholdMs?: number;
	/** 汇总窗口，默认 10 秒；窗口内无慢事件则不报告。 */
	windowMs?: number;
	/** 测试注入。 */
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	countDomNodes?: () => number;
	PerformanceObserverImpl?: typeof PerformanceObserver;
};

const INPUT_EVENT_NAMES = new Set([
	"keydown",
	"keyup",
	"keypress",
	"beforeinput",
	"input",
	"compositionstart",
	"compositionupdate",
	"compositionend",
]);

const LONG_TASK_LOOKBACK_MS = 1_000;
const MAX_RECENT_TASKS = 200;

type EventTimingEntry = PerformanceEntry & {
	processingStart: number;
	processingEnd: number;
};

function supportsEntryType(observer: typeof PerformanceObserver | undefined, type: string): boolean {
	const supported = (observer as unknown as { supportedEntryTypes?: readonly string[] } | undefined)?.supportedEntryTypes;
	return Array.isArray(supported) && supported.includes(type);
}

export function startInputLatencyMonitor(options: InputLatencyMonitorOptions): () => void {
	const Observer = options.PerformanceObserverImpl
		?? (typeof PerformanceObserver === "undefined" ? undefined : PerformanceObserver);
	if (!Observer || !supportsEntryType(Observer, "event")) return () => undefined;

	const thresholdMs = options.thresholdMs ?? 100;
	const windowMs = options.windowMs ?? 10_000;
	const now = options.now ?? (() => performance.now());
	const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs));
	const countDomNodes = options.countDomNodes ?? (() => document.getElementsByTagName("*").length);

	let slowEvents = 0;
	let byType: Record<string, number> = {};
	let worst: InputLatencySample | null = null;
	/** 最近的长任务（startTime 与 now() 同为 performance 时间轴）；上限防止空闲时无界增长。 */
	const recentTasks: Array<{ start: number; duration: number }> = [];
	let windowStartedAt = 0;
	let flushScheduled = false;
	let stopped = false;

	const flush = () => {
		flushScheduled = false;
		if (stopped || !worst) return;
		// 长任务条目与事件条目的回调先后不确定：把窗口开始前 1 秒内的长任务也算进来。
		const windowTasks = recentTasks.filter((task) => task.start >= windowStartedAt - LONG_TASK_LOOKBACK_MS);
		const longTasks = windowTasks.length;
		const longestTaskMs = windowTasks.reduce((max, task) => Math.max(max, task.duration), 0);
		const report: InputLatencyReport = {
			windowMs: Math.round(now() - windowStartedAt),
			slowEvents,
			byType,
			worst,
			longTasks,
			longestTaskMs: Math.round(longestTaskMs),
			domNodes: countDomNodes(),
		};
		slowEvents = 0;
		byType = {};
		worst = null;
		recentTasks.length = 0;
		try {
			options.report(report);
		} catch {
			// 诊断失败不能影响输入。
		}
	};

	const eventObserver = new Observer((list) => {
		for (const entry of list.getEntries() as EventTimingEntry[]) {
			if (!INPUT_EVENT_NAMES.has(entry.name) || entry.duration < thresholdMs) continue;
			if (!flushScheduled) {
				flushScheduled = true;
				windowStartedAt = now();
				setTimer(flush, windowMs);
			}
			slowEvents += 1;
			byType[entry.name] = (byType[entry.name] ?? 0) + 1;
			if (!worst || entry.duration > worst.durationMs) {
				worst = {
					name: entry.name,
					durationMs: Math.round(entry.duration),
					inputDelayMs: Math.round(entry.processingStart - entry.startTime),
					processingMs: Math.round(entry.processingEnd - entry.processingStart),
					presentationDelayMs: Math.round(entry.startTime + entry.duration - entry.processingEnd),
				};
			}
		}
	});
	// durationThreshold 最小 16ms，且按 8ms 取整；这里再按 thresholdMs 精确过滤。
	eventObserver.observe({ type: "event", durationThreshold: Math.max(16, thresholdMs), buffered: false } as PerformanceObserverInit);

	let taskObserver: PerformanceObserver | null = null;
	if (supportsEntryType(Observer, "longtask")) {
		taskObserver = new Observer((list) => {
			for (const entry of list.getEntries()) {
				recentTasks.push({ start: entry.startTime, duration: entry.duration });
			}
			// 只保留最近一段：没有慢输入时这些记录不会被报告，也不能无限累积。
			const cutoff = now() - windowMs - LONG_TASK_LOOKBACK_MS;
			while (recentTasks.length > 0 && (recentTasks[0].start < cutoff || recentTasks.length > MAX_RECENT_TASKS)) {
				recentTasks.shift();
			}
		});
		taskObserver.observe({ type: "longtask", buffered: false });
	}

	return () => {
		stopped = true;
		eventObserver.disconnect();
		taskObserver?.disconnect();
	};
}
