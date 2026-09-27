/**
 * Loader wiring for subagent-executor behavioral tests.
 *
 * The bundled pi-subagents extension sources are TypeScript modules importing
 * bare packages (typebox, yaml, @earendil-works/*) that are not vendored in this
 * checkout. installSubagentGraphLoader():
 *   - redirects those bare specifiers to `piExternalStubs.mjs`,
 *   - redirects the runSync boundary to `subagentExecutionDouble.mjs`,
 *   - redirects the background async-execution boundary to
 *     `subagentAsyncExecutionDouble.mjs`.
 * All other relative modules load the real TypeScript sources through Node's
 * built-in type stripping, so session lease, foreground control, foreground
 * history and resume dispatch are the production implementations.
 */
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_URL = pathToFileURL(path.join(HERE, "piExternalStubs.mjs")).href;
const EXECUTION_DOUBLE_URL = pathToFileURL(path.join(HERE, "subagentExecutionDouble.mjs")).href;
const ASYNC_EXECUTION_DOUBLE_URL = pathToFileURL(path.join(HERE, "subagentAsyncExecutionDouble.mjs")).href;
const DETACH_RECONCILE_DOUBLE_URL = pathToFileURL(path.join(HERE, "subagentDetachReconcileDouble.mjs")).href;

const EXTERNAL_SPECIFIERS = [
	"typebox",
	"yaml",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

const EXECUTION_TS = path.join("src", "runs", "foreground", "execution.ts");
const ASYNC_EXECUTION_TS = path.join("src", "runs", "background", "async-execution.ts");
const DETACH_RECONCILE_TS = path.join("src", "runs", "foreground", "workflow-detach-reconcile.ts");

let installed = false;

export function installSubagentGraphLoader() {
	if (installed) return;
	installed = true;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const parentURL = context.parentURL ?? "";
			const parentIsExtensionSource = parentURL.includes("pideck-q-subagents") || parentURL.includes("tests/helpers");
			if (parentIsExtensionSource && (specifier.startsWith(".") || specifier.startsWith("/"))) {
				let absolute;
				try {
					absolute = path.normalize(fileURLToPath(new URL(specifier, parentURL)));
				} catch {
					absolute = "";
				}
				if (absolute.endsWith(EXECUTION_TS)) return { url: EXECUTION_DOUBLE_URL, shortCircuit: true };
				if (absolute.endsWith(ASYNC_EXECUTION_TS)) return { url: ASYNC_EXECUTION_DOUBLE_URL, shortCircuit: true };
				if (absolute.endsWith(DETACH_RECONCILE_TS)) return { url: DETACH_RECONCILE_DOUBLE_URL, shortCircuit: true };
			}
			if (parentURL.includes("pideck-q-subagents")) {
				for (const external of EXTERNAL_SPECIFIERS) {
					if (specifier === external || specifier.startsWith(`${external}/`)) {
						return { url: STUB_URL, shortCircuit: true };
					}
				}
			}
			return nextResolve(specifier, context);
		},
	});
}
