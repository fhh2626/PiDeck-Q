/**
 * StartupBarrier (src/main/utils/StartupBarrier.ts)
 *
 * 一次性启动屏障：把「必须早于首次 pi spawn 完成的启动期异步工作」收敛成一个
 * 可 await 的 promise，同时保证它**永远不会把 Agent 启动卡死**。
 *
 * 为什么需要：迁移旧全局扩展入口这类工作天生是异步的，而 AgentManager 的 spawn
 * 由用户点「启动」触发，两者原本没有先后关系。若不串行化，迁移还没跑完就有进程
 * 起来，旧全局入口和内置 `-e` 版会同时加载（同一个扩展跑两个实例）。
 *
 * 失败安全：
 * - 任务自身失败不影响屏障（allSettled），具体原因由执行方自己写日志；
 * - wait 带超时上限，超时返回 false 让调用方记日志后照常启动。UNC 路径指向
 *   被挂起的 WSL 发行版时可以久到不可接受，绝不能把用户的「启动」点击变成
 *   永久转圈。
 */
export interface StartupBarrier {
	/** 登记一项需在首次 spawn 前完成的工作；重复登记会被合并等待。 */
	add(task: Promise<unknown>): void;
	/**
	 * 等待所有已登记工作完成，最多 `timeoutMs`。
	 * @returns true = 无待等任务或全部已 settle；false = 超时仍有任务在跑。
	 */
	wait(timeoutMs?: number): Promise<boolean>;
}

/** 默认等待上限：正常迁移是本地目录几次 stat/copy，远低于此值。 */
export const DEFAULT_STARTUP_BARRIER_TIMEOUT_MS = 10_000;

export function createStartupBarrier(): StartupBarrier {
	// 每项任务包一层“settle 时自删”的登记，这样 wait 不需要二次探测完成情况。
	let pending: Promise<unknown>[] = [];
	const track = (task: Promise<unknown>): Promise<unknown> => {
		const wrapped = Promise.resolve(task).catch(() => undefined).then(() => {
			pending = pending.filter((item) => item !== wrapped);
		});
		pending.push(wrapped);
		return wrapped;
	};
	return {
		add(task: Promise<unknown>): void {
			track(task);
		},
		async wait(timeoutMs: number = DEFAULT_STARTUP_BARRIER_TIMEOUT_MS): Promise<boolean> {
			if (pending.length === 0) return true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = Promise.allSettled(pending).then(() => true);
			const deadline = new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			});
			try {
				return await Promise.race([done, deadline]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}

/** 空屏障：未接线场景（单测/独立宿主）的兜底实现，永不等待。 */
export const noopStartupBarrier: StartupBarrier = {
	add: () => undefined,
	wait: async () => true,
};
