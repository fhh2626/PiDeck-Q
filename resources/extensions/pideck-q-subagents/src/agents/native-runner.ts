import type { AgentRunnerConfig } from "../shared/types.ts";

/** Reject retired runner definitions before they can fall through to native execution. */
export function validateNativeRunner(value: unknown, label: string): AgentRunnerConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object when provided.`);
	}
	if (!("type" in value) || value.type !== "pi") {
		throw new Error(`${label} supports only runner.type='pi'. External CLI and job runners are no longer supported in PiDeck-Q.`);
	}
	if (Object.keys(value).some((key) => key !== "type")) {
		throw new Error(`${label} supports only the 'type' field.`);
	}
	return { type: "pi" };
}
