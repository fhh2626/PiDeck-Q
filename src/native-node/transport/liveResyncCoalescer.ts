export type LiveResyncReason = "stalled-event-cursor" | "event-history-truncated" | "oversized-event";

export type LiveResyncRequest = {
	reason: LiveResyncReason;
	/** 渲染层丢失的第一帧的产生时间（monotonicNowMs 口径）；undefined 表示未知（需全量补发）。 */
	lostSinceMs?: number;
};

type TimerHandle = { unref?: () => unknown };

export type LiveResyncCoalescerOptions = {
	windowMs: number;
	/** 真正执行一次补发。 */
	run: (request: LiveResyncRequest) => void;
	/** 某次请求被并入窗口末尾的补发时回调（仅用于日志）。 */
	onCoalesced?: (request: LiveResyncRequest) => void;
	/** 补发执行期间由补发自身同步引发的请求被忽略时回调（仅用于日志）。 */
	onReentrantIgnored?: (request: LiveResyncRequest) => void;
	/**
	 * run 抛错时回调。尾随补发跑在定时器里，异常若不在这里收住会成为未捕获异常，
	 * 直接让 sidecar 进程退出；首次补发也一并收住，行为一致。
	 */
	onError?: (error: unknown, request: LiveResyncRequest) => void;
	setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimer?: (timer: TimerHandle) => void;
};

/**
 * 断层补发的节流器：窗口内第一次请求立即执行，其余请求合并成窗口结束时的一次尾随补发。
 *
 * 不能简单丢弃窗口内的请求：两个渲染层连接先后带着被裁的游标重连时，第二个连接收到
 * native.resyncRequired 后游标直接跳到最新序号，第一次补发的帧早于这个序号，它永远收不到；
 * 若第二次请求被丢弃，这个连接的界面就停在旧内容，而心跳也认为一切正常。
 * 合并时取最早的断层起点；任一请求起点未知则整体按未知（全量）处理。
 *
 * 补发执行期间同步产生的请求一律忽略：它们是补发自身引起的（例如补发推送的帧超出单帧上限
 * 被丢弃，又报告一次 oversized-event）。若把它们也排成尾随补发，尾随补发会再次引发同样的请求，
 * 形成每个窗口一次、永不停止的全量重推。
 */
export class LiveResyncCoalescer {
	private timer: TimerHandle | null = null;
	private pending: LiveResyncRequest | null = null;
	private pendingUnknownStart = false;
	private disposed = false;
	private running = false;

	constructor(private readonly options: LiveResyncCoalescerOptions) {}

	request(request: LiveResyncRequest): void {
		if (this.disposed) return;
		if (this.running) {
			this.options.onReentrantIgnored?.(request);
			return;
		}
		if (this.timer) {
			this.merge(request);
			this.options.onCoalesced?.(request);
			return;
		}
		this.execute(request);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) (this.options.clearTimer ?? defaultClearTimer)(this.timer);
		this.timer = null;
		this.pending = null;
		this.pendingUnknownStart = false;
	}

	private merge(request: LiveResyncRequest): void {
		if (request.lostSinceMs === undefined) this.pendingUnknownStart = true;
		const lostSinceMs = this.pendingUnknownStart
			? undefined
			: Math.min(this.pending?.lostSinceMs ?? Number.POSITIVE_INFINITY, request.lostSinceMs ?? Number.POSITIVE_INFINITY);
		this.pending = { reason: request.reason, lostSinceMs };
	}

	private execute(request: LiveResyncRequest): void {
		const setTimer = this.options.setTimer ?? defaultSetTimer;
		this.timer = setTimer(() => this.onWindowEnd(), this.options.windowMs);
		this.timer.unref?.();
		this.running = true;
		try {
			this.options.run(request);
		} catch (error) {
			this.options.onError?.(error, request);
		} finally {
			this.running = false;
		}
	}

	private onWindowEnd(): void {
		this.timer = null;
		if (this.disposed) return;
		const pending = this.pending;
		this.pending = null;
		this.pendingUnknownStart = false;
		if (pending) this.execute(pending);
	}
}

function defaultSetTimer(callback: () => void, delayMs: number): TimerHandle {
	return setTimeout(callback, delayMs);
}

function defaultClearTimer(timer: TimerHandle): void {
	clearTimeout(timer as ReturnType<typeof setTimeout>);
}
