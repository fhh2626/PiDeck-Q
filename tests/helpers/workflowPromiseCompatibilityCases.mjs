import assert from "node:assert/strict";
import { runWorkflowScript } from "../../resources/extensions/pideck-q-subagents/src/workflows/scripted-workflow.ts";

const run = 'runs.run("child", { agent: "readonly", task: "fixture" })';
const scenarios = [
	["plain workflow", "return 42;", 42],
	["direct await", `return (await ${run}).output;`, "child"],
	["return child promise", `return ${run};`, { key: "child", ok: true, output: "child", artifactPaths: [] }],
	["parallel runs.all", 'return (await runs.all([{key:"a",agent:"readonly"},{key:"b",agent:"readonly"}])).map(r=>r.output);', ["a", "b"]],
	["Promise.all", `return (await Promise.all([${run}]))[0].output;`, "child"],
	["Promise.allSettled", `return (await Promise.allSettled([${run}]))[0].value.output;`, "child"],
	["Promise.race", `return (await Promise.race([${run}])).output;`, "child"],
	["Promise.any", `return (await Promise.any([${run}])).output;`, "child"],
	["Promise.resolve", `return (await Promise.resolve(${run})).output;`, "child"],
	["new Promise", `return (await new Promise(resolve => resolve(${run}))).output;`, "child"],
	["await then callback child", `return (await Promise.resolve(0).then(() => ${run})).output;`, "child"],
	["return then callback child", `return Promise.resolve(0).then(() => ${run}).then(r=>r.output);`, "child"],
	["await catch callback child", `return (await Promise.reject("expected").catch(() => ${run})).output;`, "child"],
	["await finally callback child", `return await Promise.resolve(42).finally(() => ${run});`, 42],
	["await status callback child", `return (await runs.status("known").then(() => ${run})).output;`, "child"],
	["await state callback child", `return (await state.get("known").then(() => ${run})).output;`, "child"],
	["plain helper returning promise", `function child() { return ${run}; } return (await child()).output;`, "child"],
	["stored promise observed later", `const pending = ${run}; await Promise.resolve(); return (await pending).output;`, "child"],
	["late resolver adoption", `const pending = new Promise(resolve => { Promise.resolve().then(() => resolve(${run})); }); return (await pending).output;`, "child"],
	["all over callback chains", `return (await Promise.all([Promise.resolve().then(() => ${run})]))[0].output;`, "child"],
	["finally preserves rejection", `try { await Promise.reject("expected").finally(() => ${run}); } catch (error) { return error; }`, "expected"],
	["finally preserves fulfillment", `return await Promise.resolve(42).finally(() => ${run}.then(() => 99));`, 42],
	["then throw is catchable", `return await ${run}.then(() => { throw new Error("expected"); }).catch(error => error.message);`, "expected"],
	["catch child remains chained", `return await Promise.reject("expected").catch(() => ${run}).then(result => result.output);`, "child"],
	["withResolvers adopts child", `const { promise, resolve } = Promise.withResolvers(); Promise.resolve().then(() => resolve(${run})); return (await promise).output;`, "child"],
	["Promise.try adopts child", `return (await Promise.try(() => ${run})).output;`, "child"],
	["await host command", 'return (await runs.host("check", {kind:"command",command:"fixture",timeoutMs:1000})).stdout;', "fixture"],
	["await steer command", `await ${run}; return (await runs.steer("child", "fixture")).state;`, "delivered"],
	["strict then receives undefined", 'return await Promise.resolve(1).then(function () { "use strict"; return this === undefined; });', true],
	["strict catch receives undefined", 'return await Promise.reject(1).catch(function () { "use strict"; return this === undefined; });', true],
	["strict finally receives undefined", 'let correct; await Promise.resolve(1).finally(function () { "use strict"; correct = this === undefined; }); return correct;', true],
	["sloppy then stays in workflow realm", 'return await Promise.resolve(1).then(function () { return this === globalThis && !("process" in this); });', true],
	["sloppy catch stays in workflow realm", 'return await Promise.reject(1).catch(function () { return this === globalThis && !("process" in this); });', true],
	["sloppy finally stays in workflow realm", 'let correct; await Promise.resolve(1).finally(function () { correct = this === globalThis && !("process" in this); }); return correct;', true],
	["Promise facade reports static methods through in", 'return ["all" in Promise, "allSettled" in Promise, "resolve" in Promise, "missingStatic" in Promise];', [true, true, true, false]],
	["Promise facade exposes no sloppy-function caller/arguments", 'return [Reflect.ownKeys(Promise).includes("caller"), Reflect.ownKeys(Promise).includes("arguments")];', [false, false]],
	["callback does not use an overridden apply property", 'const callback = () => 42; callback.apply = () => 0; return await Promise.resolve(1).then(callback);', 42],
];
const unobserved = [
	["bare launch", `${run};`],
	["ignored then chain", `${run}.then(r=>r.output);`],
	["ignored catch chain", `${run}.catch(()=>null);`],
	["ignored finally chain", `${run}.finally(()=>null);`],
	["ignored Promise.all", `Promise.all([${run}]);`],
	["ignored Promise.resolve", `Promise.resolve(${run});`],
	["ignored constructor", `new Promise(resolve => resolve(${run}));`],
	["ignored then callback child", `Promise.resolve(0).then(() => ${run});`],
	["ignored catch callback child", `Promise.reject("expected").catch(() => ${run});`],
	["ignored finally callback child", `Promise.resolve(0).finally(() => ${run});`],
	["ignored status callback child", `runs.status("known").then(() => ${run}); await runs.status("barrier");`],
	["ignored state callback child", `state.get("known").then(() => ${run}); await runs.status("barrier");`],
	["observed base does not observe detached branch", `const base = Promise.resolve(0); base.then(() => ${run}); await base;`],
	["ignored all callback chain", `Promise.all([]).then(() => ${run});`],
];

/** Exercise the real workflow coordinator, substituting only the model/host boundaries. */
function options(script, overrides = {}) {
	return {
		script, timeoutMs: 3000,
		launch: async (key) => ({ key, ok: true, output: key, artifactPaths: [] }),
		status: async (key) => ({ key, ok: true, output: key, artifactPaths: [] }),
		state: { get: () => 0, set: () => {} },
		host: async (key) => ({ key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "fixture", stderr: "", outputPath: "", durationMs: 0 }),
		steer: async (key) => ({ key, state: "delivered" }),
		...overrides,
	};
}

/** Shared by the deterministic Node suite and isolated real Pi/Pi-Bolt diagnostics. */
export async function runWorkflowPromiseCompatibilityCases(onCase = () => {}) {
	const failures = [];
	let passed = 0;
	async function check(name, action) {
		// A real-runtime crash can otherwise erase which case was in flight.
		onCase({ name, state: "running" });
		try { await action(); passed++; }
		catch (error) { failures.push({ name, error: error.stack }); }
		finally { onCase({ name, state: "completed" }); }
	}
	for (const [name, script, expected] of scenarios) {
		await check(name, async () => {
			const result = await runWorkflowScript(options(script));
			assert.deepEqual(result.value, expected);
		});
	}
	for (const [name, expression] of unobserved) {
		await check(name, async () => {
			await assert.rejects(runWorkflowScript(options(`${expression} await Promise.resolve(); return 42;`)), /unawaited runs\.run/);
		});
	}
	await check("unawaited live child is aborted before rejection", async () => {
		let aborted = false;
		await assert.rejects(runWorkflowScript(options(`${run}; return 42;`, {
			launch: (key, _params, signal) => new Promise((resolve) => {
				signal.addEventListener("abort", () => { aborted = true; resolve({ key, ok: false, output: "stopped", artifactPaths: [] }); }, { once: true });
			}),
		})), /unawaited runs\.run/);
		assert.equal(aborted, true);
	});
	await check("external cancellation aborts awaited child", async () => {
		const controller = new AbortController();
		let aborted = false;
		await assert.rejects(runWorkflowScript(options(`return await ${run};`, {
			signal: controller.signal,
			launch: (key, _params, signal) => new Promise((resolve) => {
				signal.addEventListener("abort", () => { aborted = true; resolve({ key, ok: false, output: "stopped", artifactPaths: [] }); }, { once: true });
				queueMicrotask(() => controller.abort(new Error("fixture cancellation")));
			}),
		})), /fixture cancellation/);
		assert.equal(aborted, true);
	});
	await check("lanes observe subsequent sequential stages", async () => {
		const result = await runWorkflowScript(options('return await runs.lanes([{key:"lane",stages:[{key:"a",agent:"readonly"},{key:"b",agent:"readonly"}]}]);'));
		assert.equal(result.value[0].state, "complete");
		assert.deepEqual(result.children.map(child => child.key), ["lane.a", "lane.b"]);
	});
	await check("ignored lanes do not silently succeed", async () => {
		await assert.rejects(runWorkflowScript(options('runs.lanes([{key:"lane",stages:[{key:"a",agent:"readonly"}]}]); return 42;')), /unawaited runs\.run/);
	});
	await check("ignored host command is rejected", async () => {
		await assert.rejects(runWorkflowScript(options('runs.host("check", {kind:"command",command:"fixture",timeoutMs:1000}); return 42;')), /unawaited runs\.host/);
	});
	await check("ignored steer command is rejected", async () => {
		await assert.rejects(runWorkflowScript(options(`await ${run}; runs.steer("child", "fixture"); return 42;`)), /unawaited runs\.steer/);
	});
	await check("nested async validation still prevents launches", async () => {
		let launched = false;
		await assert.rejects(runWorkflowScript(options(`const child = async () => ${run}; return await child();`, {
			launch: async (key) => { launched = true; return { key, ok: true, output: key, artifactPaths: [] }; },
		})), /does not support nested async functions/);
		assert.equal(launched, false);
	});
	await check("child rejection remains catchable", async () => {
		const result = await runWorkflowScript(options(`return await ${run}.catch(() => "caught");`, {
			launch: async () => { throw new Error("fixture child failure"); },
		}));
		assert.equal(result.value, "caught");
	});
	return { passed, failures };
}
