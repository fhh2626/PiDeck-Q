import type { RpcLogBatch, RpcLogEntry } from "../../shared/types/rpcLog";

const FLUSH_MS = 80;
const MAX_BATCH = 100;
const MAX_PENDING = 1000;

/** Own bounded per-agent live-log queues and their single shared flush timer. */
export class LiveRpcLogBuffer {
	private readonly pending = new Map<string, RpcLogEntry[]>();
	private timer: NodeJS.Timeout | null = null;

	constructor(private readonly emit: (batch: RpcLogBatch) => void) {}

	/** Called only after AgentManager's user-controlled logging gate. */
	enqueue(entry: RpcLogEntry): void {
		let entries = this.pending.get(entry.agentId);
		if (!entries) { entries = []; this.pending.set(entry.agentId, entries); }
		if (entries.length >= MAX_PENDING) entries.splice(0, entries.length - MAX_PENDING + 1);
		entries.push(entry);
		this.schedule();
	}

	private schedule(): void {
		if (this.timer !== null || this.pending.size === 0) return;
		this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS);
		this.timer.unref?.();
	}

	/** A quiet burst must drain its remainder, not wait indefinitely for the next RPC event. */
	private flush(): void {
		for (const [agentId, entries] of [...this.pending]) {
			const batch = entries.slice(0, MAX_BATCH);
			const rest = entries.slice(MAX_BATCH);
			if (rest.length) this.pending.set(agentId, rest);
			else this.pending.delete(agentId);
			if (batch.length) this.emit({ agentId, entries: batch });
		}
		this.schedule();
	}

	/** Close only this agent; siblings keep their ordering and scheduled delivery. */
	drop(agentId: string): void {
		this.pending.delete(agentId);
		if (this.pending.size === 0) this.cancelTimer();
	}

	/** Reusable shutdown: no queued data or callback survives stopAll. */
	clear(): void {
		this.cancelTimer();
		this.pending.clear();
	}

	private cancelTimer(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
}
