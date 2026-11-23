/** Periodic parent decisions for a live child, without interrupting its work for a report. */
import { requestRunSupervision, type RunSupervisionDecision, type RunSupervisionRequest } from "../../intercom/native-supervisor-channel.ts";
import type { ChildSupervisorMetadata } from "./child-runtime-config.ts";

export const RUN_SUPERVISION_INTERVAL_MS = 600_000;

/** Logical-child timing survives model attempts without retaining their sessions or callbacks. */
export interface RunSupervisionState {
	startedAt: number;
	nextReviewAt: number;
}

/** Create once per logical child, before its first model attempt starts. */
export function createRunSupervisionState(startedAt = Date.now()): RunSupervisionState {
	return { startedAt, nextReviewAt: startedAt + RUN_SUPERVISION_INTERVAL_MS };
}

export interface RunSupervisionInput {
	metadata?: ChildSupervisorMetadata;
	state?: RunSupervisionState;
	getSnapshot(): string;
	onStop(): void;
	onError?(error: unknown): void;
	timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
	now?: () => number;
	/** Injectable transport keeps timer tests independent of files and real waiting. */
	requestDecision?: typeof requestRunSupervision;
}

/** Arm after child startup, and dispose at its authoritative completion or cancellation. */
export function createRunSupervision(input: RunSupervisionInput): { dispose(): RunSupervisionDecision | undefined } {
	const metadata = input.metadata;
	if (!metadata?.orchestratorSessionId.trim() || !metadata.runId.trim() || !metadata.agent.trim()
		|| !metadata.channelDir.trim() || !Number.isInteger(metadata.childIndex) || metadata.childIndex < 0) {
		return { dispose: () => undefined };
	}
	const timers = input.timers ?? globalThis;
	const now = input.now ?? Date.now;
	const state = input.state ?? createRunSupervisionState(now());
	const requestDecision = input.requestDecision ?? requestRunSupervision;
	let disposed = false;
	let stopRequested = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	type PendingReview = { controller: AbortController; request?: RunSupervisionRequest; decision?: RunSupervisionDecision };
	let pending: PendingReview | undefined;
	const reportError = (error: unknown): void => {
		// Reporting is advisory and must never turn a failed notification into a failed child.
		try { input.onError?.(error); } catch {}
	};
	const acceptDecision = (review: PendingReview, decision: RunSupervisionDecision, notifyStop: boolean): void => {
		if (review.decision !== undefined) return;
		review.decision = decision;
		if (decision === "stop") {
			stopRequested = true;
			if (notifyStop) input.onStop();
		} else {
			state.nextReviewAt = now() + RUN_SUPERVISION_INTERVAL_MS;
		}
	};
	const schedule = (): void => {
		if (disposed || stopRequested) return;
		timer = timers.setTimeout(() => {
			timer = undefined;
			if (disposed || stopRequested) return;
			const controller = new AbortController();
			const review: PendingReview = { controller };
			pending = review;
			void Promise.resolve().then(() => {
				if (disposed) return undefined;
				return requestDecision(metadata, input.getSnapshot(), controller.signal, (request) => { review.request = request; });
			}).then((decision) => {
				if (disposed || controller.signal.aborted || decision === undefined) return;
				acceptDecision(review, decision, true);
			}).catch((error: unknown) => {
				if (!disposed && !controller.signal.aborted) reportError(error);
			}).finally(() => {
				if (pending === review) pending = undefined;
				// A disposed attempt cannot postpone a review owned by its replacement.
				if (disposed || stopRequested) return;
				if (review.decision === undefined) state.nextReviewAt = now() + RUN_SUPERVISION_INTERVAL_MS;
				// One pending ask at a time. Expiry or transport failure preserves the live work.
				schedule();
			});
		}, Math.max(0, state.nextReviewAt - now()));
		timer.unref?.();
	};
	schedule();
	return {
		dispose() {
			if (disposed) return stopRequested ? "stop" : undefined;
			// A successful parent reply is authoritative even before the next polling tick.
			let decision: RunSupervisionDecision | undefined;
			try {
				decision = pending?.request?.readDecision();
				if (pending && decision) acceptDecision(pending, decision, false);
			} catch (error) { reportError(error); }
			disposed = true;
			if (timer) timers.clearTimeout(timer);
			timer = undefined;
			pending?.controller.abort();
			pending = undefined;
			return stopRequested ? "stop" : decision;
		},
	};
}
