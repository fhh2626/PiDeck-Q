/**
 * Default agent for single-child launches that omit `agent`.
 *
 * Why: requiring the caller to name an agent made plain delegation fail for no safety gain. The
 * default is the full-capability `writable` agent. Only a *missing* name is defaulted; a name that
 * is present but unknown still fails with the discovered-agent listing, so a mistyped `readonly`
 * can never silently become a write-capable child.
 */
export const DEFAULT_SUBAGENT_NAME = "writable";

/** Structural subset of the launch params this rule needs; keeps the module free of executor types. */
export interface DefaultAgentCandidate {
	agent?: unknown;
	task?: unknown;
	action?: unknown;
	id?: unknown;
	runId?: unknown;
	resume?: unknown;
	workflow?: unknown;
	workflowScript?: unknown;
	workflowScriptPath?: unknown;
	chain?: unknown;
	tasks?: unknown;
}

/** True when the params describe exactly one fresh child launch whose agent was left out. */
function isAgentlessSingleLaunch(params: DefaultAgentCandidate): boolean {
	if (params.agent !== undefined) return false;
	if (typeof params.task !== "string" || params.task.trim() === "") return false;
	// Management actions, retained-run resumes, workflows, and legacy multi-step shapes carry their own routing.
	if (params.action !== undefined || params.id !== undefined || params.runId !== undefined || params.resume !== undefined) return false;
	if (params.workflow !== undefined || params.workflowScript !== undefined || params.workflowScriptPath !== undefined) return false;
	if (params.chain !== undefined || params.tasks !== undefined) return false;
	return true;
}

/** Returns the same object when nothing changes, so identity-keyed launch metadata stays attached. */
export function withDefaultAgent<T extends DefaultAgentCandidate>(params: T): T {
	if (!isAgentlessSingleLaunch(params)) return params;
	return { ...params, agent: DEFAULT_SUBAGENT_NAME };
}