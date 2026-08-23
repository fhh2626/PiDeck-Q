import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	vm.runInNewContext(outputText, sandbox, {
		filename: "codexSessionMeta.ts",
	});
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
	const sandbox = { exports: {}, process, require, setTimeout };
	vm.runInNewContext(outputText, sandbox, { filename: "sessionNameLine.ts" });
	return sandbox.exports;
}

function loadSessionScanner(homePath) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const codexMeta = loadCodexMetaModule();
	const piCompatibility = loadTranspiledModule("src/shared/piCompatibility.ts");
	const messageContent = loadMessageContentModule();
	const sessionSummaryCache = loadSessionSummaryCacheModule(homePath);
	const wslPaths = loadWslPathsModule();
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		process,
		require: (id) => {
			if (id === "electron") {
				return { app: { getPath: () => homePath }, shell: {} };
			}
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../../shared/piCompatibility") return piCompatibility;
			if (id === "../pi/messageContent") return messageContent;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			// sessionNameLine 为无依赖纯函数模块，直接编译加载真实实现，保证清理口径一致
			if (id === "./sessionNameLine") return loadSessionNameLineModule();
			// sharedLogger 未注册时 getAppLogger 返回 null，SessionScanner 埋点静默跳过
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			return require(id);
		},
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "SessionScanner.ts",
	});
	const RawSessionScanner = sandbox.exports.SessionScanner;
	class WrappedSessionScanner extends RawSessionScanner {
		constructor(translate, home, ...rest) {
			super(translate, home ?? homePath, ...rest);
		}
	}
	return { ...sandbox.exports, SessionScanner: WrappedSessionScanner };
}

test("backfills Codex subagent metadata for sessions imported before grouping fields existed", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-scanner-"));
	try {
		const projectPath = "/repo/project";
		const piDir = join(home, ".pi", "agent", "sessions", "--repo-project--");
		const codexDir = join(home, ".codex", "sessions", "2026", "06", "30");
		mkdirSync(piDir, { recursive: true });
		mkdirSync(codexDir, { recursive: true });

		const codexSourcePath = join(codexDir, "rollout-child.jsonl");
		writeFileSync(
			codexSourcePath,
			`${JSON.stringify({
				type: "session_meta",
				payload: {
					id: "child-thread",
					cwd: projectPath,
					thread_source: "subagent",
					parent_thread_id: "parent-thread",
					agent_role: "worker",
					agent_nickname: "Darwin",
				},
			})}\n`,
			"utf8",
		);

		writeFileSync(
			join(piDir, "codex_child-thread.jsonl"),
			[
				JSON.stringify({ sessionName: "Reviewer", cwd: projectPath }),
				JSON.stringify({ type: "session", id: "child-thread", cwd: projectPath }),
				JSON.stringify({
					type: "codex_import",
					version: 1,
					codexSessionId: "child-thread",
					sourcePath: codexSourcePath,
					sourceMtime: 1,
					sourceSize: 1,
				}),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "review" }] },
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);

		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].codexThreadSource, "subagent");
		assert.equal(summaries[0].codexParentThreadId, "parent-thread");
		assert.equal(summaries[0].codexAgentRole, "worker");
		assert.equal(summaries[0].codexAgentNickname, "Darwin");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
