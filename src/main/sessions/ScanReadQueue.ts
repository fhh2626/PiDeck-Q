type QueuedRead = { start: () => void; cancel: (reason: Error) => void };

/** Scanner-wide read concurrency; cancellation settles callers but retains slots until actual I/O ends. */
export class ScanReadQueue {
	private readonly queued: QueuedRead[] = [];
	private readonly active = new Set<QueuedRead>();
	private closed = false;

	constructor(private readonly limit = 4) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid scan read concurrency");
	}

	run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.closed) return Promise.reject(new Error("Session scanner disposed"));
		if (signal?.aborted) return Promise.reject(signal.reason);
		return new Promise<T>((resolve, reject) => {
			const controller = new AbortController();
			const removeListener = () => signal?.removeEventListener("abort", onAbort);
			const entry: QueuedRead = {
				cancel: (reason) => {
					controller.abort(reason);
					const index = this.queued.indexOf(entry);
					if (index >= 0) this.queued.splice(index, 1);
					removeListener();
					reject(reason);
				},
				start: () => {
					this.active.add(entry);
					let task: Promise<T>;
					try { task = work(controller.signal); }
					catch (error) { task = Promise.reject(error); }
					void task.then((value) => {
						if (controller.signal.aborted) reject(controller.signal.reason);
						else resolve(value);
					}, reject).finally(() => {
						removeListener();
						this.active.delete(entry);
						this.drain();
					});
				},
			};
			const onAbort = () => entry.cancel(new Error("Session scan cancelled", { cause: signal?.reason }));
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queued.push(entry);
			this.drain();
		});
	}

	private drain(): void {
		while (!this.closed && this.active.size < this.limit && this.queued.length > 0) {
			this.queued.shift()?.start();
		}
	}

	/** Environment changes invalidate queued reads and abort active child-process signals. */
	cancel(reason = new Error("Session scan environment changed")): void {
		for (const entry of [...this.queued, ...this.active]) entry.cancel(reason);
	}

	/** Permanently stop accepting reads and release listener/queue ownership. */
	dispose(): void { this.closed = true; this.cancel(new Error("Session scanner disposed")); }
}
