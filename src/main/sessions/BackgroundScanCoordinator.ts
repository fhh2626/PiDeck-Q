/**
 * 项目会话目录后台扫描协调器（2026-08 展开项目卡顿优化）。
 *
 * 背景：展开项目时 `sessionsCatalogList` 同步全量扫描该项目全部会话 JSONL
 * （数百文件遍历 + 摘要解析），侧栏每 3 秒轮询又反复触发，主进程持续承压、
 * 渲染层长时间等待。改造后 IPC 立即返回目录缓存，扫描转入后台：
 * 本协调器负责同项目并发触发的去重与冷却合并——
 *
 * - 扫描进行中再次触发：合并为一次 pending，扫描结束后补跑最后一次提交的任务（不并发重扫）；
 * - 冷却期内触发：延迟到冷却结束再扫（避免 3 秒轮询导致连续扫描）；
 * - 占坑先于延迟：调度即标记 scanning，防止冷却等待期内被重复调度。
 */
export class BackgroundScanCoordinator {
	/** 正在扫描（含冷却等待期）的项目。 */
	private readonly scanningProjects = new Set<string>();
	/**
	 * 扫描进行中收到的新触发：扫描结束后补跑一次。记录最新任务而不是只记项目：
	 * 后来的调用方（如用户展开项目时会推送刷新的任务）不能被第一次的旧任务替换掉。
	 */
	private readonly pendingTasks = new Map<string, () => Promise<void>>();
	/** 最近一次扫描完成时间（冷却计时起点）。 */
	private readonly lastScanAtByProject = new Map<string, number>();
	/** 冷却期内尚未开始执行的延迟定时器（dispose 时清理并释放对应项目的占坑）。 */
	private readonly delayTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly cooldownMs = 5000) {}

	/**
	 * 调度一次项目扫描。
	 * @returns true = 本次调度将执行扫描（含冷却延迟后执行）；
	 *          false = 已在扫描中，合并为 pending（扫描结束后由在跑的循环补跑）。
	 */
	schedule(projectId: string, task: () => Promise<void>): boolean {
		if (this.scanningProjects.has(projectId)) {
			this.pendingTasks.set(projectId, task);
			return false;
		}
		this.scanningProjects.add(projectId);
		const lastScanAt = this.lastScanAtByProject.get(projectId) ?? 0;
		const waitMs = Math.max(0, this.cooldownMs - (Date.now() - lastScanAt));
		const timer = setTimeout(() => {
			this.delayTimers.delete(projectId);
			void this.run(projectId, task);
		}, waitMs);
		// 定时器不应阻止进程退出
		(timer as { unref?: () => void }).unref?.();
		this.delayTimers.set(projectId, timer);
		return true;
	}

	private async run(projectId: string, task: () => Promise<void>): Promise<void> {
		try {
			await task();
		} finally {
			this.lastScanAtByProject.set(projectId, Date.now());
			this.scanningProjects.delete(projectId);
			// 扫描期间积累的新触发补跑一次（新一轮仍受冷却约束）
			const pending = this.pendingTasks.get(projectId);
			if (pending) {
				this.pendingTasks.delete(projectId);
				this.schedule(projectId, pending);
			}
		}
	}

	/**
	 * 测试与退出清理：取消冷却期内的延迟定时器（扫描中的任务不可取消）。
	 * 被取消的项目同时释放占坑，否则协调器复用（后端重建）后该项目会永远只进 pending。
	 */
	dispose(): void {
		for (const [projectId, timer] of this.delayTimers) {
			clearTimeout(timer);
			this.scanningProjects.delete(projectId);
		}
		this.delayTimers.clear();
		this.pendingTasks.clear();
	}
}
