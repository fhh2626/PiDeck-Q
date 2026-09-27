/**
 * Test double for `src/runs/foreground/workflow-detach-reconcile.ts`.
 *
 * The detached-completion regression tests must be able to make the real
 * reconciliation step fail (the production implementation throws when a
 * workflow result file cannot be parsed), while still exercising the real
 * executor, lease and foreground-control code.
 *
 * Every export forwards to the real module unless a failure has been installed
 * through `setDetachReconcileFailure`.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_URL = pathToFileURL(path.join(
	HERE,
	"..", "..",
	"resources", "extensions", "pideck-q-subagents", "src", "runs", "foreground", "workflow-detach-reconcile.ts",
)).href;

const real = await import(REAL_URL);

let failure;
let throwAfterSuccess = false;

export function setDetachReconcileFailure(error, options = {}) {
	failure = error;
	throwAfterSuccess = options.afterSuccess === true;
}

export function clearDetachReconcileFailure() {
	failure = undefined;
	throwAfterSuccess = false;
}

export const applyDetachedChildToPausedWorkflow = real.applyDetachedChildToPausedWorkflow;
export const promotePausedWorkflowIfSettled = real.promotePausedWorkflowIfSettled;

export function reconcileDetachedWorkflowChildCompletion(input) {
	const succeeded = real.reconcileDetachedWorkflowChildCompletion(input);
	if (failure && (!throwAfterSuccess || succeeded === true)) {
		throw failure instanceof Error ? failure : new Error(String(failure));
	}
	return succeeded;
}
