import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime, createAgentSession, createEventBus } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

export const repo = fileURLToPath(new URL("../../", import.meta.url));
export const runtimePath = resolve(repo, "resources/extensions/pideck-q-subagents/src/runs/shared/subagent-prompt-runtime.ts");
const DIAGNOSTIC_EVENT = "test:researcher-diagnostic";

/** Deliver real runtime diagnostics through Pi's event bus, without exporting code via global state. */
export async function withResearcherSession(plan, run, { runtime = runtimePath } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "researcher-session-"));
	const eventBus = createEventBus();
	const diagnostics = [];
	const errors = [];
	const unsubscribe = eventBus.on(DIAGNOSTIC_EVENT, (value) => diagnostics.push(value));
	let session;
	try {
		const wrapper = join(dir, "prompt-runtime.ts");
		writeFileSync(wrapper, `import register from ${JSON.stringify(runtime.replaceAll("\\", "/"))};
export default function (pi) {
  register(pi, {
    agent: "researcher", requiredTools: ${JSON.stringify(plan.requiredChildTools)},
    fanoutChild: false, depth: 1, fast: false,
    waitTool: { enabled: false, defaultTimeoutMs: 1000 },
    toolDiagnostic: (diagnostic) => pi.events.emit(${JSON.stringify(DIAGNOSTIC_EVENT)}, { diagnostic })
  });
}
`);
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, eventBus,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [...plan.extensionArgs, wrapper],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, [], "actual session loader errors");
		for (const path of [...plan.extensionArgs, wrapper]) {
			assert.ok(loaded.extensions.some((ext) => resolve(ext.path) === resolve(path)), `extension not loaded: ${path}`);
		}
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(), modelsPath: null,
			allowModelNetwork: false, refreshOnCreate: false,
		});
		({ session } = await createAgentSession({
			cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
			modelRuntime, sessionManager: SessionManager.inMemory(process.cwd()), settingsManager,
			resourceLoader: loader, tools: plan.effectiveToolAllowlist, excludeTools: plan.excludeTools,
		}));
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
		assert.deepEqual(errors, [], "bind errors");
		await run({ session, loaded, async start(expectedMissing) {
			assert.deepEqual(errors, [], "unexpected error before agent_start");
			diagnostics.length = 0;
			// This verifies diagnostic delivery, not host cancellation or a live model startup.
			// foreground/execution.ts consumes the captured diagnostic and owns abortChild().
			await session.extensionRunner.emit({ type: "agent_start" });
			assert.equal(diagnostics.length, 1, "production diagnostic callback must be observed");
			const diagnostic = diagnostics[0].diagnostic;
			if (expectedMissing.length === 0) {
				assert.equal(diagnostic, undefined);
				assert.deepEqual(errors, [], "successful start diagnostic must not emit errors");
			} else {
				assert.ok(diagnostic, "inactive required tool must produce a diagnostic");
				assert.deepEqual(diagnostic.missing, expectedMissing);
				assert.deepEqual(diagnostic.required, plan.requiredChildTools);
				assert.equal(errors.length, 1, "only the expected diagnostic error is allowed");
				assert.equal(errors[0].event, "agent_start");
				assert.equal(errors[0].extensionPath, wrapper);
				assert.ok(errors[0].error.startsWith(`Agent 'researcher' requested unavailable child tools: ${expectedMissing.join(", ")}.`));
			}
			// Consume expected startup errors; shutdown errors are checked independently below.
			errors.length = 0;
		} });
	} finally {
		try {
			if (session) {
				try {
					const before = errors.length;
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
					assert.deepEqual(errors.slice(before), [], "shutdown handler errors");
				} finally {
					session.dispose();
				}
			}
		} finally {
			try { unsubscribe(); } finally { rmSync(dir, { recursive: true, force: true }); }
		}
	}
}

/** Relocate relative imports in a temporary copy; never mutate the working-tree production source. */
export function relocateRuntimeImports(source) {
	return source.replace(/(from\s+["'])(\.[^"']+)(["'])/g, (_match, before, relative, after) =>
		`${before}${resolve(dirname(runtimePath), relative).replaceAll("\\", "/")}${after}`);
}
