/**
 * Test double for `src/runs/foreground/execution.ts` (the runSync boundary).
 *
 * The foreground-resume tests replace the real runSync with a controllable stub
 * via `globalThis.__subagentTestRunSync`, so no model, pi child process, or
 * network is ever started. Everything else in the subagent executor graph stays
 * the real implementation (session lease, foreground control, history).
 */

function defaultRunSync() {
	throw new Error("runSync test double called without a registered globalThis.__subagentTestRunSync handler.");
}

export async function runSync(cwd, agents, agentName, task, options) {
	const handler = globalThis.__subagentTestRunSync ?? defaultRunSync;
	return handler(cwd, agents, agentName, task, options);
}
