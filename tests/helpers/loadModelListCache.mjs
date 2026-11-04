import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);

function loadSandboxed(filePath, sandboxExtras = {}, requireOverride = () => undefined) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const sandbox = {
		Buffer,
		console: { log() {}, warn() {}, error() {} },
		exports: {},
		process,
		...sandboxExtras,
		require: (id) => requireOverride(id) ?? require(id),
	};
	vm.runInNewContext(output, sandbox, { filename: filePath.split("/").pop() });
	return sandbox.exports;
}

/**
 * 在 vm 沙箱里装载一份全新的 modelListCache（模块级缓存状态互不干扰），并替换：
 * - child_process.spawn：RPC 路径，记录 args，返回可被 `close` 的假子进程；
 * - child_process.execFile：文本回退路径，记录 args，按 `textOutputs` 脚本化 stdout；
 * - PiRpcClient：按 `rpcResponses` 脚本化 `get_available_models` 的响应；
 * - 全局 setTimeout：把 500ms 的空结果重试间隔压成 0，测试不依赖真实时间；请求的延迟记录在 calls.delays，\n *   以便断言重试确实“等了一会儿”而不是立刻重发。
 *
 * `rpcResponses` / `textOutputs` 是“按调用顺序消费”的队列，用完后重复最后一项；
 * 响应为 Error 实例时表示该次调用失败；RPC 响应可以是返回 Promise 的函数，用来挂起在途请求。
 *
 * `realRpcClient: true` 时改用真实 PiRpcClient（读写假子进程的 stdio），配合 `onSpawn(child)`
 * 脚本化子进程行为（发 error/exit、写 stdout），用于验证进程生命周期处理。
 */
export function loadModelListCache({ rpcResponses = [], textOutputs = [], realRpcClient = false, onSpawn } = {}) {
	const calls = { spawn: [], execFile: [], resolveCommand: [], delays: [] };
	let rpcIndex = 0;
	let textIndex = 0;
	const pick = (queue, index) => queue[Math.min(index, queue.length - 1)];

	class FakeRpcClient extends EventEmitter {
		close() {}
		async request() {
			const scripted = pick(rpcResponses, rpcIndex++);
			// 函数项用于“挂起的在途请求”：由测试决定何时放行。
			const next = typeof scripted === "function" ? await scripted() : scripted;
			if (next === undefined || next instanceof Error) throw next ?? new Error("no scripted RPC response");
			return { success: true, data: { models: next } };
		}
	}

	const childProcess = {
		spawn: (command, args, options) => {
			const child = new EventEmitter();
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.killed = false;
			child.kill = () => {
				child.killed = true;
				return true;
			};
			calls.spawn.push({ command, args, options, child });
			onSpawn?.(child);
			return child;
		},
		execFile: (command, args, options, callback) => {
			calls.execFile.push({ command, args, options });
			const next = pick(textOutputs, textIndex++);
			// 真实 execFile 的回调是异步的。
			setImmediate(() => {
				if (next === undefined || next instanceof Error) callback(next ?? new Error("no scripted output"), "", "");
				else callback(null, next, "");
			});
			return new EventEmitter();
		},
	};

	const piCompatibility = loadSandboxed("src/shared/piCompatibility.ts");
	const exports = loadSandboxed(
		"src/main/pi/modelListCache.ts",
		{ setTimeout: (fn, delay) => { calls.delays.push(delay); return setImmediate(fn); } },
		(id) => {
			if (id === "node:child_process") return childProcess;
			if (id === "./PiRpcClient") {
				return realRpcClient ? loadTsCommonJs("src/main/pi/PiRpcClient.ts") : { PiRpcClient: FakeRpcClient };
			}
			if (id === "../../shared/piCompatibility") return piCompatibility;
			if (id === "./wslEnvNames") return loadTsCommonJs("src/main/pi/wslEnvNames.ts");
			return undefined;
		},
	);

	/** 假定位器：记录 resolveCommand 的全部实参，createInvocation 原样透传。 */
	const locator = {
		resolveCommand: (...args) => {
			calls.resolveCommand.push(args);
			return "pi-under-test";
		},
		createInvocation: (command, args) => ({
			command,
			args: [...args],
			shell: false,
			windowsVerbatimArguments: false,
			pathPrefix: "",
			wsl: undefined,
		}),
		createProcessEnv: () => ({}),
	};
	const settingsStore = (settings) => ({ get: () => ({ ...settings }) });
	return { ...exports, calls, locator, settingsStore };
}
