import type { GitBranchInfo } from "../../../shared/types";

export type GitRefreshIntent = "poll" | "explicit";

/** Owns branch-refresh concurrency, project epochs and failure backoff without React state. */
export class ProjectGitRefresh {
	private projectId: string | undefined;
	private epoch = 0;
	private running: { epoch: number; promise: Promise<void> } | undefined;
	private followUp = false;
	private closed = false;
	private failures = 0;
	private nextPollAt = 0;

	constructor(
		private readonly read: (projectId: string) => Promise<GitBranchInfo>,
		private readonly apply: (projectId: string, value: GitBranchInfo) => void,
		private readonly now: () => number = Date.now,
	) {}

	/** A project epoch rejects old A results even after switching A → B → A. */
	select(projectId: string | undefined): void {
		if (this.projectId === projectId) return;
		this.projectId = projectId;
		this.epoch += 1;
		this.running = undefined;
		this.followUp = false;
		this.failures = 0;
		this.nextPollAt = 0;
	}

	/** React StrictMode can set up the same owner again after its cleanup. */
	activate(): void { this.closed = false; }

	/** Invalidate uncancellable IPC responses; no timer or pending follow-up survives cleanup. */
	dispose(): void {
		this.closed = true;
		this.epoch += 1;
		this.running = undefined;
		this.followUp = false;
	}

	refresh(projectId: string, intent: GitRefreshIntent): Promise<void> {
		if (this.closed || this.projectId !== projectId) return Promise.resolve();
		if (this.running) {
			// Poll ticks must not make slow results obsolete or create endless reruns.
			// A mutation, unlike a poll, needs one read started after that mutation.
			if (intent === "explicit") this.followUp = true;
			return this.running.promise;
		}
		if (intent === "poll" && this.now() < this.nextPollAt) return Promise.resolve();
		const epoch = this.epoch;
		let response: Promise<GitBranchInfo>;
		try { response = this.read(projectId); }
		catch (error) { response = Promise.reject(error); }
		const promise = this.run(projectId, epoch, response).finally(() => {
			if (this.running?.epoch === epoch) this.running = undefined;
		});
		this.running = { epoch, promise };
		return promise;
	}

	private isCurrent(epoch: number): boolean {
		return !this.closed && epoch === this.epoch;
	}

	/** Drain only explicit follow-ups, while settling every caller on success or failure. */
	private async run(projectId: string, epoch: number, response: Promise<GitBranchInfo>): Promise<void> {
		let failed = false;
		let lastError: unknown;
		while (true) {
			try {
				const next = await response;
				if (!this.isCurrent(epoch)) return;
				this.failures = 0;
				this.nextPollAt = 0;
				this.apply(projectId, next);
				failed = false;
			} catch (error) {
				if (!this.isCurrent(epoch)) return;
				lastError = error;
				failed = true;
				this.failures += 1;
				this.nextPollAt = this.now() + Math.min(30_000, 4_000 * 2 ** Math.min(this.failures - 1, 3));
				this.apply(projectId, { current: null, branches: [] });
			}
			if (!this.isCurrent(epoch) || !this.followUp) break;
			this.followUp = false;
			try { response = this.read(projectId); }
			catch (error) { response = Promise.reject(error); }
		}
		if (failed) throw lastError;
	}
}
