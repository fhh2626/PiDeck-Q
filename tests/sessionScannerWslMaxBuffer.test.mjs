import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadTranspiledModule(filePath, overrides = new Map()) {
	const source = readFileSync(filePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		clearTimeout,
		exports: {},
		process,
		require: (id) => overrides.has(id) ? overrides.get(id) : require(id),
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

function loadCodexMetaModule() {
	const source = readFileSync("src/shared/codexSessionMeta.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, { filename: "codexSessionMeta.ts" });
	return sandbox.exports;
}

function loadSessionNameLineModule() {
	const source = readFileSync("src/main/sessions/sessionNameLine.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {}, process, require, setTimeout };
	vm.runInNewContext(outputText, sandbox, { filename: "sessionNameLine.ts" });
	return sandbox.exports;
}

function loadSessionScanner(homePath, execFileMock) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const codexMeta = loadCodexMetaModule();
	const hostInstruction = loadTranspiledModule("src/main/pi/hostInstruction.ts");
	const piCompatibility = loadTranspiledModule("src/shared/piCompatibility.ts");
	const messageContent = loadTranspiledModule(
		"src/main/pi/messageContent.ts",
		new Map([["./hostInstruction", hostInstruction]]),
	);
	const fsRetry = loadTranspiledModule("src/main/utils/fsRetry.ts");
	const sessionSummaryCache = loadTranspiledModule(
		"src/main/sessions/sessionSummaryCache.ts",
		new Map([
			["electron", { app: { getPath: () => homePath } }],
			["../utils/fsRetry", fsRetry],
		]),
	);
	const wslPaths = loadTranspiledModule("src/main/wsl/WslPaths.ts");
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		process,
		setTimeout,
		require: (id) => {
			if (id === "node:child_process") return { execFile: execFileMock };
			if (id === "electron") {
				return {
					app: {
						getPath: (key) => (key === "home" ? homePath : join(homePath, String(key))),
					},
					shell: { trashItem: async () => {} },
				};
			}
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../../shared/piCompatibility") return piCompatibility;
			if (id === "../../shared/imageContent") return loadTranspiledModule("src/shared/imageContent.ts");
			if (id === "../../shared/imageLimits") return loadTranspiledModule("src/shared/imageLimits.ts");
			if (id === "../pi/messageContent") return messageContent;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "./sessionNameLine") return loadSessionNameLineModule();
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	return sandbox.exports;
}

/**
 * 模拟 Node child_process.execFile 的 maxBuffer 语义：stdout 超过
 * options.maxBuffer（默认 1024*1024，与 Node 一致）时报
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER 并终止回调。
 * 文件内容是内存 Map（key = Linux 绝对路径），不入真实磁盘。
 */
function createWslExecFileMock(files) {
	const calls = [];
	const writes = [];
	const execFile = (cmd, args, options, callback) => {
		if (typeof options === "function") {
			callback = options;
			options = {};
		}
		calls.push({ cmd, args, options });
		const command = args[4];
		const maxBuffer = options.maxBuffer ?? 1024 * 1024;
		const maxBufferError = (bytes) => {
			const err = new Error(`maxBuffer exceeded: stdout (${bytes} > ${maxBuffer})`);
			err.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
			return err;
		};
		const enoent = (path) => {
			const err = new Error(`cat: ${path}: No such file or directory`);
			err.code = "ENOENT";
			return err;
		};

		switch (command) {
			case "cat": {
				const path = args[5];
				const content = files.get(path);
				if (content === undefined) return setImmediate(() => callback(enoent(path), "", ""));
				const size = Buffer.byteLength(content, "utf8");
				// 与真实 Node 行为一致：stdout 超过 maxBuffer 时报错，调用方只能拿到 reject
				const err = size > maxBuffer ? maxBufferError(size) : null;
				return setImmediate(() => callback(err, err ? "" : content, ""));
			}
			case "stat": {
				const path = args[7];
				const content = files.get(path) ?? "";
				const size = Buffer.byteLength(content, "utf8");
				return setImmediate(() => callback(null, `1700000000 ${size}`, ""));
			}
			case "find": {
				const root = args[5];
				const lines = [...files.keys()].filter((p) => p.startsWith(root) && p.endsWith(".jsonl"));
				return setImmediate(() => callback(null, lines.join("\n"), ""));
			}
			case "head": {
				const path = args[8];
				const content = files.get(path) ?? "";
				return setImmediate(() => callback(null, content.slice(0, Number(args[6])), ""));
			}
			case "test": {
				const path = args[5];
				return setImmediate(() => callback(files.has(path) ? null : enoent(path), "", ""));
			}
			case "tee": {
				// tee 会把 stdin 内容回显到 stdout：大文件回写同样会撞 maxBuffer
				// （真实环境里 Node 会 kill 子进程，文件可能只写了一半）
				const path = args[5];
				return {
					stdin: {
						end: (content) => {
							files.set(path, content);
							writes.push({ path, content, command: "tee" });
							const size = Buffer.byteLength(content, "utf8");
							const err = size > maxBuffer ? maxBufferError(size) : null;
							setImmediate(() => callback(err, err ? "" : content, ""));
						},
					},
				};
			}
			case "dd": {
				// dd of=path 从 stdin 写入，无 stdout 回显，永不触发 maxBuffer
				const target = args[5].startsWith("of=") ? args[5].slice(3) : null;
				return {
					stdin: {
						end: (content) => {
							if (target !== null) {
								files.set(target, content);
								writes.push({ path: target, content, command: "dd" });
							}
							setImmediate(() => callback(null, "", ""));
						},
					},
				};
			}
			default:
				return setImmediate(() => callback(null, "", ""));
		}
	};
	return { execFile, calls, writes };
}

/** 生成一个 >1MB 的合法 pi 会话 JSONL（首行 type:"session" 头 + 一条大 assistant 消息）。 */
function buildBigSessionContent() {
	const entries = [
		{ type: "session", id: "aaaa0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/mnt/h/justpi", name: "big-session" },
		{ type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: "x".repeat(1024 * 1024 + 512 * 1024) } },
	];
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** 与 pi getSessionName 一致：倒序取最后一条 session_info 的 name。 */
function piSessionName(lines) {
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.type === "session_info") return entry.name?.trim() || undefined;
		} catch {
			// 跳过不可解析行
		}
	}
	return undefined;
}

const WSL_ENV = { distro: "Ubuntu", user: "u", linuxHome: "/home/u" };
const BIG_PATH = "/home/u/.pi/agent/sessions/big.jsonl";

test("WSL list() 能识别超过 1MB 的会话（#147 回归：大文件不被 maxBuffer 截断丢弃）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-big-"));
	try {
		const bigContent = buildBigSessionContent();
		assert.ok(Buffer.byteLength(bigContent, "utf8") > 1024 * 1024, "fixture 必须超过 1MB 才有效");
		const mock = createWslExecFileMock(new Map([[BIG_PATH, bigContent]]));
		const { SessionScanner } = loadSessionScanner(home, mock.execFile);
		const scanner = new SessionScanner();
		await scanner.configureWsl(WSL_ENV);

		const list = await scanner.list();

		// 修复前：readWslFile 默认 maxBuffer=1MB 溢出 → readSummary 返回 null → 会话消失
		assert.equal(list.length, 1, "超过 1MB 的 WSL 会话不应从列表消失");
		assert.equal(list[0].name, "big-session");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("WSL 重命名超过 1MB 的会话不报错且追加 session_info（#147 回归）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-rename-"));
	try {
		const bigContent = buildBigSessionContent();
		const mock = createWslExecFileMock(new Map([[BIG_PATH, bigContent]]));
		const { SessionScanner } = loadSessionScanner(home, mock.execFile);
		const scanner = new SessionScanner();
		await scanner.configureWsl(WSL_ENV);

		// 修复前：readWslFile（读全文）与 writeWslFile（tee 回显）都会撞 1MB 上限
		await scanner.rename(BIG_PATH, "renamed");

		const written = mock.writes.find((w) => w.path === BIG_PATH);
		assert.ok(written, "重命名应回写文件");
		assert.equal(piSessionName(written.content.split(/\r?\n/)), "renamed");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
