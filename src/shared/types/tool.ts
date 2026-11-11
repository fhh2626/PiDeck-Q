/** Shared presentation outcome for recorded tool calls. Unknown means no result evidence, not activity or failure. */
export type ToolOutcomeStatus = "running" | "done" | "error" | "unknown";
