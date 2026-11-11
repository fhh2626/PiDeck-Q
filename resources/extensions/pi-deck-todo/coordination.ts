import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi's in-process event bus, scoped to a session; this is not a second desktop channel. */
export const TODO_TASK_PAUSE_EVENT = "pi-deck-todo:pause";

/** An explicit plan pause/close must also prevent goal's next automatic request. */
export function pauseTodoTask(pi: ExtensionAPI, ctx: ExtensionContext): void {
	pi.events?.emit(TODO_TASK_PAUSE_EVENT, ctx.sessionManager.getSessionId());
}
