import type { EventBus } from "@earendil-works/pi-coding-agent";

const CHILD_LOADER_QUERY = "pideck-subagents:child-loader-query";

/** Claim only this loader's event bus before optional extension paths are evaluated. */
export function registerChildLoaderIdentity(events: EventBus): () => void {
	return events.on(CHILD_LOADER_QUERY, (query) => {
		if (typeof query === "object" && query !== null && "accept" in query && typeof query.accept === "function") query.accept();
	});
}

/** Loader identity survives module reloads without changing the parent process environment. */
export function isChildLoader(events: Pick<EventBus, "emit"> | undefined): boolean {
	let child = false;
	events?.emit(CHILD_LOADER_QUERY, { accept: () => { child = true; } });
	return child;
}
