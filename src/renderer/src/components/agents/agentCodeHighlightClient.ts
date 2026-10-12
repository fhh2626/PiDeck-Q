import type {
	AgentCodeHighlightHandle,
	AgentCodeLanguage,
	HighlightFailure,
	HighlightResponse,
	HighlightWorkerPort,
	HighlightSuccess,
} from "./agentHighlightTypes";
import type { AgentCodeTokenLines } from "./agentCodeTokenCache";

/**
 * 高亮请求调度器：把 shiki 的同步计算交给唯一的页面级 Worker，并管住它的生命周期。
 *
 * 规则（性能与稳定性都靠它们）：
 * - **一个页面一个 Worker**：shiki 有主题/grammar 常驻内存，多个 Worker 会成倍占用；
 * - **同一段代码只算一次**：相同 language+code 的请求合并到同一个任务上共享结果；
 * - **同时只跑一个任务**：其余排队，避免 Worker 内部同步计算互相排队却占满内存；
 * - **取消按消费者计**：某个组件卸载只移除它自己，不影响同一任务的其它消费者；
 * - **任务超时**：超时说明 Worker 已不可信（死锁/OOM），直接终止、拒绝、清空状态，
 *   下次请求重建 Worker；
 * - **空闲回收**：长时间没有请求就终止 Worker，把 shiki 常驻内存还给系统。
 *
 * 这里刻意**不做**主线程回退：回退会让「卡顿」重新出现在主线程上，
 * 而且掩盖 Worker 失败。失败时上层按纯文本呈现即可（可读、无高亮）。
 */

/** 单个任务的超时：超过即认为 Worker 不可用。 */
export const HIGHLIGHT_TASK_TIMEOUT_MS = 30_000;
/** 空闲多久后回收 Worker。 */
export const HIGHLIGHT_IDLE_TEARDOWN_MS = 30_000;

interface HighlightConsumer {
	resolve: (lines: AgentCodeTokenLines) => void;
	reject: (error: Error) => void;
	cancelled: boolean;
}

interface HighlightTask {
	requestId: number;
	key: string;
	code: string;
	language: AgentCodeLanguage;
	consumers: Set<HighlightConsumer>;
	settled: boolean;
}

/**
 * 取错误消息。
 * 不用 `instanceof Error`：错误可能来自另一个 realm（Worker、VM），
 * 跨 realm 的 instanceof 会失败；按形状读 `message` 更可靠。
 */
function errorMessage(error: unknown, fallback: string): string {
	if (typeof error === "object" && error !== null) {
		const message = Reflect.get(error, "message");
		if (typeof message === "string" && message) return message;
	}
	return fallback;
}

export interface AgentCodeHighlightClient {
	/** 请求高亮一段代码；返回可单独取消的句柄。 */
	request: (code: string, language: AgentCodeLanguage) => AgentCodeHighlightHandle;
	/** 终止 Worker 并清空所有状态（测试/退出用）。 */
	dispose: () => void;
	/** 诊断：排队 + 执行中的任务数。 */
	pendingTaskCount: () => number;
	/** 诊断：当前是否持有 Worker。 */
	hasWorker: () => boolean;
}

export interface AgentCodeHighlightClientOptions {
	/** 创建 Worker；默认实现动态加载 Worker 入口模块（持 Worker 入口 URL，不能在单测里静态加载）。 */
	createWorker: () => Promise<HighlightWorkerPort>;
	taskTimeoutMs?: number;
	idleTeardownMs?: number;
}

export function createAgentCodeHighlightClient(
	options: AgentCodeHighlightClientOptions,
): AgentCodeHighlightClient {
	const taskTimeoutMs = options.taskTimeoutMs ?? HIGHLIGHT_TASK_TIMEOUT_MS;
	const idleTeardownMs = options.idleTeardownMs ?? HIGHLIGHT_IDLE_TEARDOWN_MS;

	let worker: HighlightWorkerPort | null = null;
	let workerPromise: Promise<HighlightWorkerPort> | null = null;
	let unsubscribe: (() => void) | null = null;
	let disposed = false;
	let workerGeneration = 0;
	let nextRequestId = 1;
	/** 正在执行的任务（最多一个）。 */
	let current: HighlightTask | null = null;
	/** 等待执行的任务，按请求先后排队（相同 key 会合并到已有任务）。 */
	const queue: HighlightTask[] = [];
	let taskTimer: ReturnType<typeof setTimeout> | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTaskTimer() {
		if (taskTimer === null) return;
		clearTimeout(taskTimer);
		taskTimer = null;
	}

	function clearIdleTimer() {
		if (idleTimer === null) return;
		clearTimeout(idleTimer);
		idleTimer = null;
	}

	/** 终止 Worker 并释放订阅；不影响已排队任务（由调用方决定如何处理）。 */
	function dropWorker() {
		// 清空 Promise 引用并不能取消已经注册的异步创建回调，因此递增代际使旧创建失效。
		workerGeneration += 1;
		clearIdleTimer();
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		if (worker) {
			worker.terminate();
			worker = null;
		}
		workerPromise = null;
	}

	function scheduleIdleTeardown() {
		if (idleTimer !== null || !worker || current || queue.length > 0) return;
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (current || queue.length > 0) return;
			dropWorker();
		}, idleTeardownMs);
	}

	function settle(task: HighlightTask, outcome: HighlightSuccess | HighlightFailure) {
		if (task.settled) return;
		task.settled = true;
		if (current === task) {
			current = null;
			clearTaskTimer();
		}
		for (const consumer of task.consumers) {
			if (consumer.cancelled) continue;
			if (outcome.type === "highlight-result") consumer.resolve(outcome.lines);
			else consumer.reject(new Error(outcome.message));
		}
		task.consumers.clear();
		pump();
	}

	/** Worker 不可信时的统一处理：终止、拒绝全部任务、清空状态。 */
	function failEverything(message: string) {
		clearTaskTimer();
		dropWorker();
		const tasks = current ? [current, ...queue] : [...queue];
		current = null;
		queue.length = 0;
		for (const task of tasks) {
			task.settled = true;
			for (const consumer of task.consumers) {
				if (!consumer.cancelled) consumer.reject(new Error(message));
			}
			task.consumers.clear();
		}
	}

	function handleMessage(response: HighlightResponse) {
		// 只认当前任务的结果：迟到的旧请求结果直接丢弃。
		if (!current || current.requestId !== response.requestId) return;
		settle(current, response);
	}

	async function ensureWorker(): Promise<HighlightWorkerPort> {
		if (worker) return worker;
		if (!workerPromise) {
			const creationGeneration = workerGeneration;
			workerPromise = options.createWorker().then((port) => {
				if (disposed || creationGeneration !== workerGeneration) {
					// 已在创建过程中被销毁或因超时/清空而失效：立刻回收，避免泄漏孤儿 Worker。
					port.terminate();
					throw new Error(
						disposed ? "highlight client disposed" : "highlight worker creation invalidated",
					);
				}
				worker = port;
				unsubscribe = port.subscribe(handleMessage);
				return port;
			});
		}
		return workerPromise;
	}

	function startTask(task: HighlightTask) {
		current = task;
		clearIdleTimer();
		taskTimer = setTimeout(() => {
			taskTimer = null;
			// 超时 = Worker 已不可信：终止、拒绝全部任务、清空，下次请求重建。
			failEverything("code highlight timed out");
		}, taskTimeoutMs);
		void ensureWorker()
			.then((port) => {
				if (task.settled) return;
				port.postMessage({
					type: "highlight",
					requestId: task.requestId,
					code: task.code,
					language: task.language,
				});
			})
			.catch((error: unknown) => {
				// Worker 起不来：同样按不可用处理，不做主线程回退。
				if (task.settled) return;
				failEverything(errorMessage(error, "code highlight worker unavailable"));
			});
	}

	function pump() {
		if (current || disposed) return;
		const next = queue.shift();
		if (next) {
			startTask(next);
			return;
		}
		scheduleIdleTeardown();
	}

	function findJoinableTask(key: string): HighlightTask | undefined {
		if (current && !current.settled && current.key === key) return current;
		return queue.find((task) => !task.settled && task.key === key);
	}

	function request(code: string, language: AgentCodeLanguage): AgentCodeHighlightHandle {
		const key = `${language}\u0000${code}`;
		const consumer: HighlightConsumer = {
			resolve: () => {},
			reject: () => {},
			cancelled: false,
		};
		const promise = new Promise<AgentCodeTokenLines>((resolve, reject) => {
			consumer.resolve = resolve;
			consumer.reject = reject;
		});

		const existing = findJoinableTask(key);
		let task = existing;
		if (!task) {
			task = {
				requestId: nextRequestId++,
				key,
				code,
				language,
				consumers: new Set(),
				settled: false,
			};
			queue.push(task);
		}
		const target = task;
		// 先登记消费者再起任务：避免任务同步完成时漏掉本消费者。
		target.consumers.add(consumer);
		pump();

		return {
			promise,
			cancel: () => {
				consumer.cancelled = true;
				target.consumers.delete(consumer);
				// 还没开始执行且已无消费者：从队列摘掉，别浪费一次 Worker 往返。
				if (!target.settled && target !== current && target.consumers.size === 0) {
					const index = queue.indexOf(target);
					if (index >= 0) queue.splice(index, 1);
				}
			},
		};
	}

	function dispose() {
		disposed = true;
		failEverything("code highlight client disposed");
	}

	return {
		request,
		dispose,
		pendingTaskCount: () => queue.length + (current ? 1 : 0),
		hasWorker: () => worker !== null,
	};
}
