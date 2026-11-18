export const TOOL_TIMEOUT_ENV = "PI_SUBAGENT_TOOL_TIMEOUT_MS";

/** Maximum delay a Node.js timer accepts without overflow. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Tools whose normal job can be to wait for a person or another run. */
export const TOOL_TIMEOUT_EXEMPT_TOOLS = new Set(["contact_supervisor", "intercom", "bg_wait"]);

// Backward-compatible export name for existing callers/tests.
export const TOOL_TIMEOUT_ALLOWLIST = TOOL_TIMEOUT_EXEMPT_TOOLS;

export function isToolTimeoutExempt(toolName: string | undefined): boolean {
	return toolName !== undefined && TOOL_TIMEOUT_EXEMPT_TOOLS.has(toolName);
}

/** Tool deadlines are opt-in. A slow built-in must not silently abort its child run. */
export function effectiveToolTimeoutMs(toolName: string | undefined, configuredToolTimeoutMs: number | undefined): number | undefined {
	if (isToolTimeoutExempt(toolName)) return undefined;
	return configuredToolTimeoutMs;
}

export function formatToolTimeoutMessage(toolName: string, timeoutMs: number): string {
	return `Tool '${toolName}' exceeded its timeout of ${timeoutMs}ms.`;
}

export function toolTimeoutCallKey(event: { toolCallId?: unknown; toolName?: unknown }, fallbackId: number): string {
	return typeof event.toolCallId === "string" && event.toolCallId.length > 0
		? `id:${event.toolCallId}`
		: `anon:${String(event.toolName ?? "tool")}:${fallbackId}`;
}

export interface ToolTimeoutResolutionInput {
	/** Per-call value from the subagent tool params (highest precedence). */
	callValue?: unknown;
	/** Agent frontmatter default (second precedence). */
	agentValue?: number;
	/** Global extension config.toolTimeoutMs (third precedence). */
	configValue?: unknown;
	/** PI_SUBAGENT_TOOL_TIMEOUT_MS environment override (lowest precedence). */
	envValue?: string | undefined;
}

/** Preserve explicit timeout settings without applying a built-in default. */
export function resolveToolTimeoutMs(input: ToolTimeoutResolutionInput): { toolTimeoutMs?: number; error?: string } {
	const candidates: Array<{ label: string; value: unknown }> = [
		{ label: "toolTimeoutMs", value: input.callValue },
		{ label: "agent.toolTimeoutMs", value: input.agentValue },
		{ label: "config.toolTimeoutMs", value: input.configValue },
	];
	let winner: { label: string; value: unknown } | undefined;
	for (const candidate of candidates) {
		if (candidate.value === undefined) continue;
		winner = candidate;
		break;
	}
	if (winner === undefined && input.envValue !== undefined && input.envValue.trim() !== "") {
		winner = { label: TOOL_TIMEOUT_ENV, value: input.envValue };
	}
	if (winner === undefined) return {};

	let raw: unknown = winner.value;
	let parsed: number;
	if (winner.label === TOOL_TIMEOUT_ENV && typeof raw === "string") {
		parsed = Number(raw);
		if (raw.trim() !== "" && !Number.isNaN(parsed)) raw = parsed;
	}
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_TIMER_DELAY_MS) {
		return { error: `${winner.label} must be a positive integer no larger than ${MAX_TIMER_DELAY_MS}.` };
	}
	return { toolTimeoutMs: raw };
}

/** Read the environment override without requiring callers to know the name. */
export function toolTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env[TOOL_TIMEOUT_ENV];
}
