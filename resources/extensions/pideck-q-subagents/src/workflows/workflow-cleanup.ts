/** Bounded drain after abort: an uncooperative host/steer callback must not swallow the VM timeout. */
export const WORKFLOW_CLEANUP_TIMEOUT_MS = 1000;

/** Observe every outstanding promise, but report incomplete cleanup instead of waiting forever. */
export async function drainWorkflowOperations(promises: Promise<unknown>[], timeoutMs = WORKFLOW_CLEANUP_TIMEOUT_MS): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.allSettled(promises).then(() => true),
			new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
