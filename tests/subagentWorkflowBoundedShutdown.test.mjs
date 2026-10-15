import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runWorkflowScript } from "../resources/extensions/pideck-q-subagents/src/workflows/scripted-workflow.ts";

// Isolate the VM so the pre-fix never-settling cleanup cannot hang the test runner itself.
for (const operation of ["host", "steer"]) {
	test(`workflow timeout returns even when a ${operation} implementation ignores abort`, () => {
		const source = `
			void (async () => {
			const { runWorkflowScript } = await import('./resources/extensions/pideck-q-subagents/src/workflows/scripted-workflow.ts');
			const guard = setTimeout(() => { console.error('CLEANUP_STUCK'); process.exit(42); }, 2500);
			try {
				await runWorkflowScript({
					script: ${JSON.stringify(operation === "host" ? 'return await runs.host("check", { kind: "command", command: "fake", timeoutMs: 100 });' : 'await runs.run("child", { agent: "readonly", task: "fake" }); return await runs.steer("child", "check");')},
					timeoutMs: 100,
					launch: async (key) => ({ key, ok: true, output: 'done', artifactPaths: [] }),
					host: () => new Promise(() => {}),
					steer: () => new Promise(() => {}),
				});
				process.exit(43);
			} catch (error) {
				if (!error.message.includes('timed out')) { console.error(error); process.exit(44); }
				clearTimeout(guard); process.exit(0);
			}
			})().catch((error) => { console.error(error); process.exit(45); });
		`;
		const child = spawnSync(process.execPath, ["-e", source], { cwd: process.cwd(), encoding: "utf8", timeout: 6000 });
		assert.equal(child.status, 0, child.stderr || child.error?.message || `exit ${child.status}`);
	});
	for (const reason of ["default-abort", "frozen-error"]) {
		test(`${reason} settles even when ${operation} cleanup ignores cancellation`, () => {
			const source = `
				void (async () => {
					const { runWorkflowScript } = await import('./resources/extensions/pideck-q-subagents/src/workflows/scripted-workflow.ts');
					const controller = new AbortController();
					const reason = ${reason === "default-abort" ? "undefined" : 'Object.freeze(Object.assign(new Error("frozen cancellation"), { workflowErrorKind: "timeout" }))'};
					const guard = setTimeout(() => { console.error('CLEANUP_STUCK'); process.exit(42); }, 3000);
					const blocked = () => { queueMicrotask(() => controller.abort(reason)); return new Promise(() => {}); };
					try {
						await runWorkflowScript({
							script: ${JSON.stringify(operation === "host" ? 'return runs.host("check", { kind: "command", command: "fake", timeoutMs: 5000 });' : 'await runs.run("child", { agent: "readonly", task: "fake" }); return runs.steer("child", "check");')},
							signal: controller.signal, timeoutMs: 5000,
							launch: async (key) => ({ key, ok: true, output: 'done', artifactPaths: [] }),
							host: blocked, steer: blocked,
						});
						process.exit(43);
					} catch (error) {
						if (!error.message.includes('Cleanup did not settle') || !error.message.includes('may still be live')) { console.error(error); process.exit(44); }
						if (error.cause?.cause !== controller.signal.reason || error.partial.trace.length === 0) { console.error(error); process.exit(47); }
						if (${JSON.stringify(reason)} === 'frozen-error' && (error.errorKind !== 'timeout' || reason.message !== 'frozen cancellation')) { console.error(error); process.exit(45); }
						clearTimeout(guard); process.exit(0);
					}
				})().catch((error) => { console.error(error); process.exit(46); });
			`;
			const child = spawnSync(process.execPath, ["-e", source], { cwd: process.cwd(), encoding: "utf8", timeout: 6000 });
			assert.equal(child.status, 0, child.stderr || child.error?.message || `exit ${child.status}`);
		});
	}
}

test("a throwing teardown hook rejects with the original checkpoint rather than orphaning the VM", async () => {
	const error = new Error("teardown hook failed");
	await assert.rejects(runWorkflowScript({
		script: 'emit("checkpoint"); return "done";', timeoutMs: 1000,
		launch: async (key) => ({ key, ok: true, output: "done", artifactPaths: [] }),
		registerStopChild(callback) { if (!callback) throw error; },
	}), (failure) => {
		assert.match(failure.message, /Workflow cleanup failed: teardown hook failed/);
		assert.equal(failure.cause, error);
		assert.deepEqual(failure.partial.emits, ["checkpoint"]);
		return true;
	});
});
