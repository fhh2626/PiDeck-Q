import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function loadMessageContentModule() {
	const compilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
	};
	const hostInstruction = { exports: {} };
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/pi/hostInstruction.ts", "utf8"), { compilerOptions }).outputText,
		hostInstruction,
		{ filename: "hostInstruction.ts" },
	);
	const messageContent = {
		exports: {},
		require: (id) => {
			if (id === "./hostInstruction") return hostInstruction.exports;
			throw new Error(`Unexpected messageContent import: ${id}`);
		},
	};
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/pi/messageContent.ts", "utf8"), { compilerOptions }).outputText,
		messageContent,
		{ filename: "messageContent.ts" },
	);
	return messageContent.exports;
}

function loadWslPathsModule() {
	const source = readFileSync("src/main/wsl/WslPaths.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadFsRetryModule() {
	// fsRetry 只依赖 node:fs/promises，随 sessionSummaryCache 一起编译注入，
	// 让真实实现（含 EPERM 退避重试）在测试中同样生效
	const source = readFileSync("src/main/utils/fsRetry.ts", "utf8");
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
		require,
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "fsRetry.ts" });
	return sandbox.exports;
}

function loadSessionSummaryCacheModule(homePath) {
	const source = readFileSync("src/main/sessions/sessionSummaryCache.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const fsRetry = loadFsRetryModule();
	const sandbox = {
		clearTimeout: () => undefined,
		exports: {},
		process,
		require: (id) => {
			if (id === "electron") {
				return {
					app: {
						getPath: (name) => name === "userData" ? join(homePath, "user-data") : homePath,
					},
				};
			}
			// fsRetry 只依赖 node:fs/promises，走真实 require 即可
			if (id === "../utils/fsRetry") return fsRetry;
			return require(id);
		},
		setTimeout: () => ({ unref: () => undefined }),
	};
	vm.runInNewContext(outputText, sandbox, { filename: "sessionSummaryCache.ts" });
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
	const sandbox = {
		exports: {},
		process,
		require,
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "sessionNameLine.ts" });
	return sandbox.exports;
}

function loadPiCompatibilityModule() {
	return loadTranspiledModule("src/shared/piCompatibility.ts");
}

function loadSessionScanner(homePath, fsOverrides = {}, childProcessOverrides = {}) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const codexMeta = loadCodexMetaModule();
	const messageContent = loadMessageContentModule();
	const sessionSummaryCache = loadSessionSummaryCacheModule(homePath);
	const wslPaths = loadWslPathsModule();
	const piCompatibility = loadPiCompatibilityModule();
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		process,
		setTimeout,
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => homePath }, shell: {} };
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../pi/messageContent") return messageContent;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "../../shared/piCompatibility") return piCompatibility;
			// sessionNameLine 为无依赖纯函数模块，直接编译加载真实实现，保证清理口径一致
			if (id === "./sessionNameLine") return loadSessionNameLineModule();
			// sharedLogger 未注册时 getAppLogger 返回 null，SessionScanner 埋点静默跳过
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			if (id === "node:child_process") return { ...require(id), ...childProcessOverrides };
			if (id === "node:fs") return { ...require(id), ...fsOverrides };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	const RawSessionScanner = sandbox.exports.SessionScanner;
	class WrappedSessionScanner extends RawSessionScanner {
		constructor(translate, home, ...rest) {
			super(translate, home ?? homePath, ...rest);
		}
	}
	return { ...sandbox.exports, SessionScanner: WrappedSessionScanner };
}

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function session(name, cwd) {
	return [
		{ type: "session_info", name, cwd },
		{ type: "message", message: { role: "user", content: "hello" } },
	];
}

test("validates a local parent session by reading only the bounded file head", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-head-"));
	try {
		const fixture = Buffer.from(`${JSON.stringify({ type: "session_info", name: "Parent" })}\n`);
		let requestedBytes = 0;
		let closed = false;
		const { SessionScanner } = loadSessionScanner(home, {
			openSync: () => 42,
			readSync: (_fd, buffer, offset, length) => {
				requestedBytes = length;
				fixture.copy(buffer, offset);
				return fixture.length;
			},
			closeSync: () => { closed = true; },
		});
		const scanner = new SessionScanner();
		assert.equal(scanner.isSessionFile("virtual-parent.jsonl"), true);
		assert.equal(requestedBytes, 4096);
		assert.equal(closed, true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("aborts a hung WSL scan before the renderer watchdog and allows a clean retry", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-scan-timeout-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		scanner.wslConfig = { distro: "Ubuntu", user: "dev", home: "/home/dev" };
		scanner.scanTimeoutMs = 10;
		let attempts = 0;
		scanner.collectWslJsonl = async (_sessionsDir, signal) => {
			attempts += 1;
			if (attempts > 1) return [];
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};

		await assert.rejects(scanner.list());
		assert.equal((await scanner.list()).length, 0);
		assert.equal(attempts, 2);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("hides persisted pi-subagents runs without deleting them or unrelated nested sessions", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-subagent-scanner-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const parentFile = join(piDir, "parent.jsonl");
		const workerFile = join(piDir, "parent", "run-abc", "run-0", "session.jsonl");
		const reviewerFile = join(piDir, "parent", "run-abc", "run-1", "session.jsonl");
		const nestedUserFile = join(piDir, "manual", "notes.jsonl");
		const lookalikeFile = join(piDir, "manual", "arbitrary", "run-0", "session.jsonl");

		writeSession(parentFile, session("Parent", projectPath));
		writeSession(join(piDir, "ordinary.jsonl"), session("Ordinary", projectPath));
		writeSession(join(piDir, "subagent-looking-name.jsonl"), session("subagent-worker-manual-0", projectPath));
		// This sibling makes lookalikeFile collide with the legacy ownership layout.
		writeSession(join(piDir, "manual.jsonl"), session("Manual owner", projectPath));
		writeSession(nestedUserFile, session("Nested user session", projectPath));
		writeSession(lookalikeFile, session("Path lookalike", projectPath));
		// Explicit metadata covers new runs even when intercom naming is unavailable.
		writeSession(workerFile, [
			...session("Worker without generated name", projectPath),
			{ type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } },
		]);
		// Generated naming plus the standard path retains compatibility with old runs.
		writeSession(reviewerFile, session("subagent-reviewer-run-abc-1", projectPath));

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		const visiblePaths = new Set(summaries.map(summary => summary.filePath));

		assert.equal(visiblePaths.has(parentFile), true);
		assert.equal(visiblePaths.has(nestedUserFile), true);
		assert.equal(visiblePaths.has(lookalikeFile), true);
		// 子会话仍然在摘要列表中，但标记了父会话路径
		assert.equal(visiblePaths.has(workerFile), true);
		assert.equal(visiblePaths.has(reviewerFile), true);
		assert.equal(summaries.some(summary => summary.name === "subagent-worker-manual-0"), true);
		assert.equal(existsSync(workerFile), true);
		assert.equal(existsSync(reviewerFile), true);
		// 验证子会话的 parentSessionPath 指向正确的父会话文件
		const workerSummary = summaries.find(s => s.filePath === workerFile);
		assert.equal(workerSummary.isInternalSubagent, true);
		assert.equal(workerSummary.parentSessionPath, parentFile);
		const reviewerSummary = summaries.find(s => s.filePath === reviewerFile);
		assert.equal(reviewerSummary.isInternalSubagent, true);
		assert.equal(reviewerSummary.parentSessionPath, parentFile);
		const lookalikeSummary = summaries.find(s => s.filePath === lookalikeFile);
		assert.notEqual(lookalikeSummary.isInternalSubagent, true);
		const namedLikeWorker = summaries.find(s => s.name === "subagent-worker-manual-0");
		assert.ok(namedLikeWorker);
		assert.notEqual(namedLikeWorker.isInternalSubagent, true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("groups WSL child sessions with POSIX parent paths", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-subagent-scanner-"));
	try {
		const projectPath = "/mnt/f/git-optimize";
		const selectedProjectPath = "//wsl.localhost/Ubuntu/mnt/f/git-optimize";
		const sessionsRoot = "/home/dev/.pi/agent/sessions";
		const parentFile = `${sessionsRoot}/--mnt-f-git-optimize--/parent.jsonl`;
		const forkParentFile = `${sessionsRoot}/--mnt-f-git-optimize--/fork-parent.jsonl`;
		const childFile = `${sessionsRoot}/--mnt-f-git-optimize--/parent/run-abc/run-0/session.jsonl`;
		const forkChildFile = `${sessionsRoot}/--mnt-f-git-optimize--/detached/run-xyz/run-0/session.jsonl`;
		const files = new Map([
			[parentFile, `${session("Parent", projectPath).map((entry) => JSON.stringify(entry)).join("\n")}\n`],
			[forkParentFile, `${session("Fork parent", projectPath).map((entry) => JSON.stringify(entry)).join("\n")}\n`],
			[childFile, `${session("subagent-worker-wsl-0", projectPath).map((entry) => JSON.stringify(entry)).join("\n")}\n`],
			[forkChildFile, `${[
				{ type: "session", id: "wsl-fork-child", parentSession: "../../../fork-parent.jsonl", cwd: projectPath },
				...session("subagent-worker-wsl-fork-0", projectPath),
			].map((entry) => JSON.stringify(entry)).join("\n")}\n`],
		]);
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		scanner.wslConfig = { distro: "Ubuntu", user: "dev", home: "/home/dev" };
		scanner.collectWslJsonl = async () => [...files.keys()];
		const fullReadCount = new Map();
		scanner.readWslFile = async (filePath) => {
			fullReadCount.set(filePath, (fullReadCount.get(filePath) ?? 0) + 1);
			const value = files.get(filePath);
			if (value == null) throw new Error(`missing WSL fixture: ${filePath}`);
			return value;
		};
		scanner.readWslFileHead = async (filePath) => {
			const value = files.get(filePath);
			if (value == null) throw new Error(`missing WSL fixture: ${filePath}`);
			return value.slice(0, 4096);
		};
		scanner.readWslFileVersion = async (filePath) => ({
			mtimeMs: 1,
			size: Buffer.byteLength(files.get(filePath) ?? "", "utf8"),
		});
		scanner.existsWslFile = async (filePath) => files.has(filePath);
		// 避免 resolveScanRoots 走真实 wsl.exe 探测自定义 sessionDir
		scanner.existsWslDir = async () => false;

		const summaries = await scanner.list(selectedProjectPath);
		assert.equal(summaries.length, 4);
		assert.equal(summaries.find((item) => item.filePath === childFile)?.isInternalSubagent, true);
		assert.equal(summaries.find((item) => item.filePath === childFile)?.parentSessionPath, parentFile);
		assert.equal(summaries.find((item) => item.filePath === forkChildFile)?.isInternalSubagent, true);
		assert.equal(summaries.find((item) => item.filePath === forkChildFile)?.parentSessionPath, forkParentFile);
		assert.equal(summaries.some((item) => item.parentSessionPath?.includes("\\")), false);
		assert.equal(fullReadCount.get(parentFile), 1);
		assert.equal(fullReadCount.get(forkParentFile), 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("uses a valid renamed parent session and ignores false-positive path owners", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-renamed-parent-subagent-scanner-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const parentFile = join(piDir, "renamed-parent.jsonl");
		const childFile = join(piDir, "renamed-parent", "run-abc", "run-0", "session.jsonl");
		const fakeOwnerFile = join(piDir, "manual.jsonl");
		const lookalikeFile = join(piDir, "manual", "arbitrary", "run-0", "session.jsonl");

		writeSession(parentFile, [
			{ sessionName: "Renamed parent", ts: Date.now() },
			...session("Original parent", projectPath),
		]);
		writeSession(childFile, session("subagent-worker-renamed-parent-0", projectPath));
		writeSession(fakeOwnerFile, [{ sessionName: "Not a Pi session" }]);
		writeSession(lookalikeFile, session("Path lookalike", projectPath));

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		assert.equal(summaries.find((item) => item.filePath === childFile)?.isInternalSubagent, true);
		assert.equal(summaries.find((item) => item.filePath === childFile)?.parentSessionPath, parentFile);
		assert.equal(summaries.find((item) => item.filePath === lookalikeFile)?.isInternalSubagent, undefined);
		assert.equal(summaries.find((item) => item.filePath === lookalikeFile)?.parentSessionPath, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("handles orphan, fork, rename and imported-session compatibility without false positives", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-orphan-subagent-scanner-"));
	try {
		const projectPath = "/repo/project";
		const piDir = join(home, ".pi", "agent", "sessions", "--repo-project--");
		const orphanFile = join(piDir, "deleted-parent", "orphan-run", "run-0", "session.jsonl");
		const renamedChildFile = join(piDir, "renamed-parent", "manual-run", "run-0", "session.jsonl");
		const legacyForkFile = join(piDir, "legacy-fork.jsonl");
		const manualForkFile = join(piDir, "manual-fork.jsonl");
		const markedCustomFile = join(piDir, "custom-child-location.jsonl");
		const importedFile = join(piDir, "codex-parent", "import-run", "run-0", "session.jsonl");

		writeSession(orphanFile, session("subagent-worker-orphan-run-0", projectPath));
		// PiDeck rename prepends sessionName; the original generated session_info remains authoritative.
		writeSession(renamedChildFile, [
			{ sessionName: "Renamed child", cwd: projectPath },
			...session("subagent-worker-old-run-0", projectPath),
		]);
		writeSession(legacyForkFile, [
			{ type: "session", id: "legacy-child", parentSession: "parent-session.jsonl", cwd: projectPath },
			...session("subagent-worker-fork-run-0", projectPath),
		]);
		writeSession(manualForkFile, [
			{ type: "session", id: "manual-child", parentSession: "parent-session.jsonl", cwd: projectPath },
			{ type: "session_info", name: "subagent-worker-copied-parent-0", cwd: projectPath },
			...session("Manual user fork", projectPath),
		]);
		writeSession(markedCustomFile, [
			...session("Custom-location child", projectPath),
			{ type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } },
		]);
		writeSession(join(piDir, "codex-parent.jsonl"), session("Codex owner", projectPath));
		writeSession(importedFile, [
			...session("subagent-reviewer-import-run-0", projectPath),
			{ type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } },
			{ type: "codex_import", version: 1, codexSessionId: "codex-child", sourcePath: join(home, "missing.jsonl") },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		const visiblePaths = new Set(summaries.map(summary => summary.filePath));

		// 子会话包含在摘要列表中，但标记了 parentSessionPath
		assert.equal(visiblePaths.has(orphanFile), true);
		assert.equal(visiblePaths.has(renamedChildFile), true);
		assert.equal(visiblePaths.has(legacyForkFile), true);
		assert.equal(visiblePaths.has(manualForkFile), true);
		assert.equal(visiblePaths.has(markedCustomFile), true);
		assert.equal(visiblePaths.has(importedFile), true);
		// 父文件不存在时不能把路径形似扩展产物的 JSONL 静默挂到虚构父会话下。
		const orphanSummary = summaries.find(s => s.filePath === orphanFile);
		assert.equal(orphanSummary.isInternalSubagent, true);
		assert.equal(orphanSummary.parentSessionPath, undefined);
		// renamedChild: 父文件不存在，不能挂到虚构父会话下。
		const renamedSummary = summaries.find(s => s.filePath === renamedChildFile);
		assert.equal(renamedSummary.isInternalSubagent, true);
		assert.equal(renamedSummary.parentSessionPath, undefined);
		// legacyFork: 标准 .jsonl 文件路径不可推断父会话，fork parent 文件不存在
		const forkSummary = summaries.find(s => s.filePath === legacyForkFile);
		assert.equal(forkSummary.isInternalSubagent, true);
		assert.equal(forkSummary.parentSessionPath, undefined);
		// markedCustomFile: 显式标记，路径不可推断父会话（无 parentSessionPath）
		const customSummary = summaries.find(s => s.filePath === markedCustomFile);
		assert.equal(customSummary.isInternalSubagent, true);
		assert.equal(customSummary.parentSessionPath, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("resolves fork child with absolute Windows parent path via parentSession header", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-abs-fork-scanner-"));
	try {
		const projectPath = "C:\\repo\\project";
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const projDir = join(sessionsRoot, "--C--repo-project--");
		const parentFile = join(projDir, "parent.jsonl");
		const forkChildFile = join(projDir, "fork-child.jsonl");

		writeSession(parentFile, session("Parent", projectPath));
		writeSession(forkChildFile, [
			{ type: "session", parentSession: parentFile, cwd: projectPath },
			...session("subagent-reviewer-abc-1", projectPath),
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		assert.equal(summaries.length, 2);
		const forkSummary = summaries.find(s => s.filePath === forkChildFile);
		assert.equal(forkSummary.isInternalSubagent, true);
		assert.equal(forkSummary.parentSessionPath, parentFile);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("resolves Rust Pi branchedFrom headers as parent sessions", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rust-branched-session-"));
	try {
		const projectPath = "C:\\repo\\project";
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const projectDir = join(sessionsRoot, "--C--repo-project--");
		const parentFile = join(projectDir, "parent.jsonl");
		const childFile = join(projectDir, "rust-child.jsonl");
		writeSession(parentFile, session("Parent", projectPath));
		writeSession(childFile, [
			{ type: "session", id: "rust-child", branchedFrom: parentFile, cwd: projectPath },
			...session("subagent-rust-child", projectPath),
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		assert.equal(summaries.find((item) => item.filePath === childFile)?.isInternalSubagent, true);
		assert.equal(summaries.find((item) => item.filePath === childFile)?.parentSessionPath, parentFile);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("recovers last-used model from assistant message when JSONL has no model_change", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-model-fallback-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const sessionFile = join(piDir, "legacy.jsonl");
		writeSession(sessionFile, [
			{ type: "session_info", name: "Legacy Session", cwd: projectPath },
			// No model_change / thinking_level_change — only message-level provider/model.
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hello" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					content: [{ type: "text", text: "hi there" }],
				},
			},
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);

		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].model?.provider, "deepseek");
		assert.equal(summaries[0].model?.modelId, "deepseek-v4-pro");
		assert.equal(summaries[0].thinkingLevel, "off");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("model_change takes precedence over message-level model", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-model-prec-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const sessionFile = join(piDir, "mixed.jsonl");
		writeSession(sessionFile, [
			{ type: "session_info", name: "Mixed Session", cwd: projectPath },
			// Assistant message first, then explicit model_change — the latter must win.
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-4o",
					content: [{ type: "text", text: "first" }],
				},
			},
			{
				type: "model_change",
				provider: "anthropic",
				modelId: "claude-sonnet-4",
			},
			{
				type: "thinking_level_change",
				thinkingLevel: "high",
			},
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);

		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].model?.provider, "anthropic");
		assert.equal(summaries[0].model?.modelId, "claude-sonnet-4");
		assert.equal(summaries[0].thinkingLevel, "high");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("marks a custom-location child as internal even when the parent path cannot be resolved", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-unresolved-parent-subagent-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const childFile = join(piDir, "custom-child-location.jsonl");
		writeSession(childFile, [
			{ type: "session_info", name: undefined, cwd: projectPath },
			{ type: "message", message: { role: "user", content: "[prompt redacted]..." } },
			{ type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		const childSummary = summaries.find((item) => item.filePath === childFile);
		assert.equal(childSummary.isInternalSubagent, true);
		assert.equal(childSummary.parentSessionPath, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("only user messages yield undefined model and undefined thinking", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-user-only-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const sessionFile = join(piDir, "user-only.jsonl");
		writeSession(sessionFile, [
			{ type: "session_info", name: "User Only", cwd: projectPath },
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hello" }],
				},
			},
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);

		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].model, undefined);
		assert.equal(summaries[0].thinkingLevel, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("isIgnoredSessionScanDirectory correctly identifies artifact directories across Windows and POSIX paths", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-ignored-dirs-"));
	try {
		const { isIgnoredSessionScanDirectory, SessionScanner } = loadSessionScanner(home);

		// 1. subagent-artifacts 目录及内部文件判定
		assert.equal(isIgnoredSessionScanDirectory("subagent-artifacts"), true);
		assert.equal(isIgnoredSessionScanDirectory("subagent-artifacts/"), true);
		assert.equal(isIgnoredSessionScanDirectory("C:\\Users\\dev\\.pi\\agent\\sessions\\parent\\subagent-artifacts"), true);
		assert.equal(isIgnoredSessionScanDirectory("C:\\Users\\dev\\.pi\\agent\\sessions\\parent\\subagent-artifacts\\run-1_worker_transcript.jsonl"), true);
		assert.equal(isIgnoredSessionScanDirectory("/home/dev/.pi/agent/sessions/parent/subagent-artifacts"), true);
		assert.equal(isIgnoredSessionScanDirectory("/home/dev/.pi/agent/sessions/parent/subagent-artifacts/run-1_worker_transcript.jsonl"), true);

		// 2. .pi/subagents/artifacts 目录及内部文件判定
		assert.equal(isIgnoredSessionScanDirectory(".pi/subagents/artifacts"), true);
		assert.equal(isIgnoredSessionScanDirectory(".pi\\subagents\\artifacts"), true);
		assert.equal(isIgnoredSessionScanDirectory("C:\\repo\\project\\.pi\\subagents\\artifacts"), true);
		assert.equal(isIgnoredSessionScanDirectory("C:\\repo\\project\\.pi\\subagents\\artifacts\\review_transcript.jsonl"), true);
		assert.equal(isIgnoredSessionScanDirectory("/home/dev/project/.pi/subagents/artifacts"), true);
		assert.equal(isIgnoredSessionScanDirectory("/home/dev/project/.pi/subagents/artifacts/review_transcript.jsonl"), true);

		// 3. 归档目录（.pideck-archive）判定
		assert.equal(isIgnoredSessionScanDirectory(".pideck-archive"), true);
		assert.equal(isIgnoredSessionScanDirectory("C:\\Users\\dev\\.pi\\agent\\sessions\\.pideck-archive"), true);
		assert.equal(isIgnoredSessionScanDirectory("/home/dev/.pi/agent/sessions/.pideck-archive"), true);

		// 4. 合法会话文件与目录绝不误判
		assert.equal(isIgnoredSessionScanDirectory("C:\\Users\\dev\\.pi\\agent\\sessions\\parent.jsonl"), false);
		assert.equal(isIgnoredSessionScanDirectory("C:\\Users\\dev\\.pi\\agent\\sessions\\parent"), false);
		assert.equal(isIgnoredSessionScanDirectory("C:\\Users\\dev\\.pi\\agent\\sessions\\parent\\run-abc\\run-0\\session.jsonl"), false);
		assert.equal(isIgnoredSessionScanDirectory("C:\\Users\\dev\\.pi\\agent\\sessions\\parent\\run-abc\\run-0"), false);
		assert.equal(isIgnoredSessionScanDirectory("C:\\Users\\dev\\.pi\\agent\\sessions\\subagent-worker-manual-0.jsonl"), false);
		assert.equal(isIgnoredSessionScanDirectory("C:\\repo\\project\\.pi\\sessions"), false);
		assert.equal(isIgnoredSessionScanDirectory("C:\\repo\\project\\.pi\\subagents"), false);
		assert.equal(isIgnoredSessionScanDirectory("/home/dev/.pi/agent/sessions/parent/run-abc/run-0/session.jsonl"), false);
		assert.equal(isIgnoredSessionScanDirectory("/home/dev/project/.pi/sessions/normal.jsonl"), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("native/local scan skips subagent-artifacts and .pi/subagents/artifacts without content filtering", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-artifact-filter-native-"));
	try {
		const projectPath = join(home, "project");
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const parentFile = join(piDir, "parent.jsonl");
		const ordinaryFile = join(piDir, "ordinary.jsonl");
		const realChildFile = join(piDir, "parent", "run-abc", "run-0", "session.jsonl");

		// 1. subagent-artifacts 下的 transcript.jsonl（包含 [prompt redacted] 文本）
		const artifactTranscriptFile = join(piDir, "parent", "subagent-artifacts", "run-abc_worker_transcript.jsonl");

		// 2. 项目 .pi 目录下配置 sessionDir: ".pi"，让扫描根真实覆盖 .pi
		//    并在 .pi 下同时放置合法会话和 .pi/subagents/artifacts/transcript.jsonl
		const projectPiDir = join(projectPath, ".pi");
		const projectSettingsFile = join(projectPiDir, "settings.json");
		const projectSessionFile = join(projectPiDir, "project-session.jsonl");
		const projectArtifactFile = join(projectPiDir, "subagents", "artifacts", "run-xyz_reviewer_transcript.jsonl");

		mkdirSync(projectPiDir, { recursive: true });
		writeFileSync(projectSettingsFile, JSON.stringify({ sessionDir: ".pi" }), "utf8");

		// 3. 用户合法会话，正文恰好包含 [prompt redacted]（用于验证不依赖内容做过滤）
		const legitWithRedactedTextFile = join(piDir, "legit-redacted-text.jsonl");

		writeSession(parentFile, session("Parent Session", projectPath));
		writeSession(ordinaryFile, session("Ordinary Session", projectPath));
		// 真实 subagent child session
		writeSession(realChildFile, session("subagent-worker-run-abc-0", projectPath));

		// 伪造 artifact 目录下的 transcript 文件（格式也是有效 JSONL，且包含 [prompt redacted]）
		writeSession(artifactTranscriptFile, [
			{ type: "session_info", name: "Prompt Audit: [prompt redacted]", cwd: projectPath },
			{ type: "message", message: { role: "user", content: "[prompt redacted] Please review code." } },
			{ type: "message", message: { role: "assistant", content: "Done." } },
		]);
		writeSession(projectSessionFile, session("Project Session in .pi", projectPath));
		writeSession(projectArtifactFile, [
			{ type: "session_info", name: "[prompt redacted]", cwd: projectPath },
			{ type: "message", message: { role: "user", content: "Prompt A: [prompt redacted]" } },
		]);

		// 合法会话包含 [prompt redacted] 字符，必须正常呈现，绝不能被文本规则误杀
		writeSession(legitWithRedactedTextFile, [
			{ type: "session_info", name: "Legit Session With Prompt Audit", cwd: projectPath },
			{ type: "message", message: { role: "user", content: "Here is [prompt redacted] text in normal chat." } },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();

		// 验证当 artifact 目录本身作为扫描根传入时，入口守卫直接返回空数组
		const directArtifactDirFiles = await scanner.collectJsonl(join(piDir, "parent", "subagent-artifacts"));
		assert.deepEqual([...directArtifactDirFiles], [], "collectJsonl on subagent-artifacts root must return empty array");
		const directProjectArtifactDirFiles = await scanner.collectJsonl(join(projectPiDir, "subagents", "artifacts"));
		assert.deepEqual([...directProjectArtifactDirFiles], [], "collectJsonl on .pi/subagents/artifacts root must return empty array");

		// 直接验证 collectJsonl 在扫描覆盖 .pi 的目录时跳过 .pi/subagents/artifacts
		const directPiFiles = await scanner.collectJsonl(projectPiDir);
		assert.equal(directPiFiles.includes(projectSessionFile), true, "collectJsonl must find project-session.jsonl in .pi");
		assert.equal(directPiFiles.includes(projectArtifactFile), false, "collectJsonl must ignore .pi/subagents/artifacts/*");

		const summaries = await scanner.list(projectPath);
		const scannedPaths = new Set(summaries.map(s => s.filePath));

		// 验证普通会话和 .pi 配置扫描根下的会话正常被扫描
		assert.equal(scannedPaths.has(parentFile), true, "Parent session must be scanned");
		assert.equal(scannedPaths.has(ordinaryFile), true, "Ordinary session must be scanned");
		assert.equal(scannedPaths.has(projectSessionFile), true, "Project session in configured .pi sessionDir must be scanned");
		assert.equal(scannedPaths.has(legitWithRedactedTextFile), true, "Legit session with [prompt redacted] in text must NOT be filtered out");

		// 验证真实 subagent child session 正常被扫描且挂载到父会话
		assert.equal(scannedPaths.has(realChildFile), true, "Real subagent child session must be scanned");
		const childSummary = summaries.find(s => s.filePath === realChildFile);
		assert.equal(childSummary?.isInternalSubagent, true, "Real child session must have isInternalSubagent = true");
		assert.equal(childSummary?.parentSessionPath, parentFile, "Real child session must point to parentSessionPath");

		// 验证 subagent-artifacts 与 .pi/subagents/artifacts 下的文件绝不进入 SessionScanner
		assert.equal(scannedPaths.has(artifactTranscriptFile), false, "subagent-artifacts transcript must not enter SessionScanner");
		assert.equal(scannedPaths.has(projectArtifactFile), false, ".pi/subagents/artifacts transcript must not enter SessionScanner even when scan root covers .pi");

		// 磁盘上的文件并未被误删，只是被扫描器忽略
		assert.equal(existsSync(artifactTranscriptFile), true, "Artifact file remains safely on disk");
		assert.equal(existsSync(projectArtifactFile), true, "Project artifact file remains safely on disk");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("WSL scan path excludes subagent-artifacts and .pi/subagents/artifacts via find args and path filter", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-artifact-filter-wsl-"));
	try {
		const projectPath = "/mnt/c/repo/project";
		const sessionsRoot = "/home/dev/.pi/agent/sessions";
		const parentFile = `${sessionsRoot}/--mnt-c-repo-project--/parent.jsonl`;
		const childFile = `${sessionsRoot}/--mnt-c-repo-project--/parent/run-abc/run-0/session.jsonl`;
		const artifactFile = `${sessionsRoot}/--mnt-c-repo-project--/parent/subagent-artifacts/run-abc_worker_transcript.jsonl`;
		const projectArtifactFile = `${sessionsRoot}/--mnt-c-repo-project--/.pi/subagents/artifacts/reviewer_transcript.jsonl`;
		const promptRedactedFile = `${sessionsRoot}/--mnt-c-repo-project--/redacted-in-content.jsonl`;

		let capturedFindArgs = [];
		const childProcessMock = {
			execFile: (_cmd, args, _opts, cb) => {
				if (Array.isArray(args) && args.includes("find")) {
					capturedFindArgs = [...args];
					// 模拟 find 输出：即使底层 find 返回了所有文件，JS 层 filter 也必须双重守卫
					const output = [
						parentFile,
						childFile,
						artifactFile,
						projectArtifactFile,
						promptRedactedFile,
					].join("\n");
					cb(null, output);
					return;
				}
				cb(null, "");
			},
		};

		const files = new Map([
			[parentFile, `${session("Parent WSL", projectPath).map(e => JSON.stringify(e)).join("\n")}\n`],
			[childFile, `${session("subagent-worker-wsl-0", projectPath).map(e => JSON.stringify(e)).join("\n")}\n`],
			[artifactFile, `${session("Prompt Audit: [prompt redacted]", projectPath).map(e => JSON.stringify(e)).join("\n")}\n`],
			[projectArtifactFile, `${session("[prompt redacted]", projectPath).map(e => JSON.stringify(e)).join("\n")}\n`],
			[promptRedactedFile, `${[
				{ type: "session_info", name: "User Prompt Audit", cwd: projectPath },
				{ type: "message", message: { role: "user", content: "[prompt redacted] Normal user query" } },
			].map(e => JSON.stringify(e)).join("\n")}\n`],
		]);

		const { SessionScanner } = loadSessionScanner(home, {}, childProcessMock);
		const scanner = new SessionScanner();
		scanner.wslConfig = { distro: "Ubuntu", user: "dev", home: "/home/dev" };
		scanner.readWslFile = async (filePath) => {
			const content = files.get(filePath);
			if (!content) throw new Error(`Missing WSL file: ${filePath}`);
			return content;
		};
		scanner.readWslFileHead = async (filePath) => {
			const content = files.get(filePath);
			if (!content) throw new Error(`Missing WSL file head: ${filePath}`);
			return content.slice(0, 4096);
		};
		scanner.existsWslFile = async (filePath) => files.has(filePath);

		const summaries = await scanner.list(projectPath);
		const scannedPaths = new Set(summaries.map(s => s.filePath));

		// 验证 WSL 模式下若直接以 artifact 目录为 sessionsDir，入口守卫直接返回空数组
		const directWslArtifactFiles = await scanner.collectWslJsonl(
			`${sessionsRoot}/--mnt-c-repo-project--/parent/subagent-artifacts`,
		);
		assert.deepEqual([...directWslArtifactFiles], [], "collectWslJsonl on subagent-artifacts root must return empty array");

		// 1. 验证 find 命令参数中包含了排除规则
		assert.ok(capturedFindArgs.includes("*/subagent-artifacts/*"), "WSL find args must exclude */subagent-artifacts/*");
		assert.ok(capturedFindArgs.includes("*/.pi/subagents/artifacts/*"), "WSL find args must exclude */.pi/subagents/artifacts/*");
		assert.ok(capturedFindArgs.includes("*/.pideck-archive/*"), "WSL find args must exclude */.pideck-archive/*");

		// 2. 验证 artifact 文件被排除在 summaries 外
		assert.equal(scannedPaths.has(artifactFile), false, "WSL subagent-artifacts transcript must not enter summaries");
		assert.equal(scannedPaths.has(projectArtifactFile), false, "WSL .pi/subagents/artifacts transcript must not enter summaries");

		// 3. 验证真实父会话和子会话正常保留
		assert.equal(scannedPaths.has(parentFile), true, "WSL parent session must be scanned");
		assert.equal(scannedPaths.has(childFile), true, "WSL real child session must be scanned");
		const childSummary = summaries.find(s => s.filePath === childFile);
		assert.equal(childSummary?.isInternalSubagent, true, "WSL real child session must be internal subagent");
		assert.equal(childSummary?.parentSessionPath, parentFile, "WSL real child session must point to parent file");

		// 4. 验证内容中包含 [prompt redacted] 的合法会话正常保留（不依赖内容过滤）
		assert.equal(scannedPaths.has(promptRedactedFile), true, "WSL legit session with [prompt redacted] must be scanned");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
