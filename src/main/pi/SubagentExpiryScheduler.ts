/**
 * One unref'ed deadline per agent, paired with cancel on runtime cleanup.
 * Heartbeats extend data deadlines, not timers: an earlier armed timer may wake,
 * recheck the refreshed deadline, and rearm once instead of churning every second.
 */
export class SubagentExpiryScheduler {
	private readonly timers = new Map<string, { deadline: number; timer: ReturnType<typeof setTimeout> }>();

	constructor(private readonly expire: (agentId: string) => void) {}

	schedule(agentId: string, deadline: number | undefined): void {
		if (deadline === undefined) { this.cancel(agentId); return; }
		const current = this.timers.get(agentId);
		if (current && current.deadline <= deadline) return;
		this.cancel(agentId);
		const timer = setTimeout(() => {
			this.timers.delete(agentId);
			this.expire(agentId);
		}, Math.max(0, deadline - Date.now()));
		timer.unref?.();
		this.timers.set(agentId, { deadline, timer });
	}

	cancel(agentId: string): void {
		const current = this.timers.get(agentId);
		if (current) clearTimeout(current.timer);
		this.timers.delete(agentId);
	}
}
