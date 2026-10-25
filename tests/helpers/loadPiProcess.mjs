import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadSandboxed(filePath) {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile(filePath), sandbox, { filename: filePath.split("/").pop() });
	return sandbox.exports;
}

function createChildProcess() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

/**
 * 在 vm 沙箱中装载 PiProcess，并替换 child_process / RPC / 定位器 / 内置扩展拼接。
 *
 * - `spawnCalls` 收集每次 spawn 的 command/args/options，供断言最终启动参数与环境。
 * - `versionOutput` 是 `pi --version` 的伪输出；信任标志与运行时识别都依赖它，
 *   所以测试可以用真实的 Pi / Pi-Bolt 版本串验证分支，而不启动真实进程。
 */
export function loadPiProcess(spawnCalls, { versionOutput = "0.81.1\n", versionGate, versionResult, now = Date.now } = {}) {
	const paths = loadSandboxed("src/main/wsl/WslPaths.ts");
	const extensionFilter = loadSandboxed("src/main/pi/piExtensionFilter.ts");
	const compatibility = loadSandboxed("src/shared/piCompatibility.ts");
	class FakeRpcClient extends EventEmitter {
		close() {}
	}
	class FakePiLocator {}
	const sandbox = {
		Buffer,
		console: { log() {}, warn() {}, error() {} },
		Date: class extends Date { static now() { return now(); } },
		exports: {},
		process,
		require: (id) => {
			if (id === "node:child_process") {
				return {
					// 真实 execFile 的回调一定异步。PiProcess 先执行 execFile 再写入 pending 缓存，
					// 同步回调会让 "done" 被随后的 "pending" 覆盖，从而永远读不到版本。
					execFile: (_command, _args, _options, callback) => {
						// versionGate（可选 Promise）模拟一次迟迟不返回的 --version 探测：放行前回调不触发。
						const deliver = () => {
							const result = versionResult?.() ?? { error: null, stdout: versionOutput };
							callback(result.error, result.stdout, "");
						};
						if (versionGate) void versionGate.then(() => setImmediate(deliver));
						else setImmediate(deliver);
						return new EventEmitter();
					},
					spawn: (command, args, options) => {
						const child = createChildProcess();
						spawnCalls.push({ command, args, options, child });
						return child;
					},
				};
			}
			if (id === "./PiRpcClient") return { PiRpcClient: FakeRpcClient };
			if (id === "./PiLocator") return { PiLocator: FakePiLocator };
			if (id === "../../shared/piCompatibility") return compatibility;
			if (id === "../wsl/WslPaths") return paths;
			if (id === "./piExtensionFilter") return extensionFilter;
			// 25fd516 起 PiProcess 引入内置扩展参数拼接；这些测试只关心路径转换与运行时参数，
			// mock 为原样透传，避免 vm sandbox 的 require 按 tests/ 相对路径误解析。
			if (id === "../extensions/builtInExtensions") {
				return { appendBuiltInExtensionArgs: (args) => [...args] };
			}
			// sharedLogger 未注册时 getAppLogger 返回 null，PiProcess 埋点静默跳过
			if (id === "../logging/sharedLogger") {
				return { getAppLogger: () => null };
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, { filename: "PiProcess.ts" });
	return sandbox.exports;
}
