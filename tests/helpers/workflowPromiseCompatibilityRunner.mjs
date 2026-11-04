import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { runWorkflowPromiseCompatibilityCases } from "./workflowPromiseCompatibilityCases.mjs";

// Assert the preload actually reached eval workers; --import alone does not do so.
const worker = new Worker(`
	const { parentPort } = require("node:worker_threads");
	const vm = require("node:vm");
	const { promiseHooks } = require("node:v8");
	const context = vm.createContext({});
	const prototype = vm.runInContext("(async () => {})().constructor.prototype", context);
	let hooks = true;
	try { promiseHooks.createHook({})(); } catch (error) { if (error.name !== "NotImplementedError") throw error; hooks = false; }
	parentPort.postMessage({
		mutableHost: Object.getOwnPropertyDescriptor(Promise.prototype, "then").writable,
		mutableVm: Object.getOwnPropertyDescriptor(prototype, "then").writable,
		hooks,
	});
`, { eval: true });
try {
	const capabilities = await new Promise((resolve, reject) => {
		worker.once("message", resolve);
		worker.once("error", reject);
	});
	const mode = process.env.PIDECK_TEST_PROMISE_MODE;
	assert.deepEqual(capabilities, {
		mutableHost: !mode.includes("immutable"), mutableVm: !mode.includes("immutable"), hooks: !mode.includes("nohooks"),
	});
} finally {
	await worker.terminate();
}
const report = await runWorkflowPromiseCompatibilityCases();
console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
