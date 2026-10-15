/** Own abort forwarding separately from a provisional detach receipt. */
export function createForegroundAbortScope(input: {
	origin?: AbortSignal;
	isDetached(): boolean;
	retainAbortOnDetach?: boolean;
}): { controller: AbortController; dispose(): void } {
	const controller = new AbortController();
	const forward = () => {
		// A direct detached child can outlive the original tool call. An attached workflow child
		// still belongs to the same VM/deadline even after yielding for supervisor coordination.
		if (!input.isDetached() || input.retainAbortOnDetach) controller.abort(input.origin?.reason);
	};
	if (input.origin?.aborted) forward();
	else input.origin?.addEventListener("abort", forward, { once: true });
	return { controller, dispose: () => input.origin?.removeEventListener("abort", forward) };
}
