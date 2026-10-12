/**
 * Test double for `src/runs/background/async-execution.ts`.
 *
 * Foreground-resume tests must never start background runners. Calls land here
 * only when a test explicitly exercises a background path; each entry point
 * delegates to `globalThis.__subagentTestAsync` when the test registered one and
 * otherwise fails loudly so an unintended background launch cannot pass.
 */

export const DEFAULT_ASYNC_TIMEOUT_MS = 30 * 60 * 1000;

function hooks() {
	return globalThis.__subagentTestAsync ?? {};
}

function unexpected(name) {
	throw new Error(`async-execution test double '${name}' was called without a registered globalThis.__subagentTestAsync handler; background launch was not expected.`);
}

export function isAsyncAvailable() {
	return hooks().isAsyncAvailable?.() ?? true;
}

export function formatAsyncStartedMessage(text) {
	return text;
}

// Must mirror the production contract exactly: a workflow-owned async child
// publishes its awaited result at workflowAwaitedAsyncResultPath(asyncDir).
export function workflowAwaitedAsyncResultPath(asyncDir) {
	return `${asyncDir}/workflow-result.json`;
}

export function buildAsyncRunnerSteps(...args) {
	return hooks().buildAsyncRunnerSteps ? hooks().buildAsyncRunnerSteps(...args) : unexpected("buildAsyncRunnerSteps");
}

export function executeAsyncSingle(...args) {
	return hooks().executeAsyncSingle ? hooks().executeAsyncSingle(...args) : unexpected("executeAsyncSingle");
}

export function executeAsyncChain(...args) {
	return hooks().executeAsyncChain ? hooks().executeAsyncChain(...args) : unexpected("executeAsyncChain");
}
