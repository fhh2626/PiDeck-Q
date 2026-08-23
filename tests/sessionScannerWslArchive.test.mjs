import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * 回归测试：WSL 环境下「首次普通 list() 之前」调用 listArchived()。
 *
 * 背景：构造函数会把 activeScanRoots 初始化为 [this.root]（本机 Windows 会话根）。
 * 若 configureWsl() 后不清空 activeScanRoots，listArchived() 会拿本机 root 去执行
 * WSL 的 `find`，导致刚切换到 WSL 时看不到 WSL 归档会话。
 *
 * 这里用 mock 的 node:child_process.execFile 捕获 `find <dir>` 的 <dir>，
 * 断言 WSL 模式下它指向 <linuxHome>/.pi/agent/sessions 的归档子目录，而非本机 root。
 */

function transpile(filePath) {
	const source = readFileSync(filePath, "utf8");
	return ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModuleInSandbox(filePath, requireFn) {
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		process,
		setTimeout,
		require: requireFn,
	};
	vm.runInNewContext(transpile(filePath), sandbox, { filename: filePath });
	return sandbox.exports;
}

/** 构造一个记录 find 目录的 execFile mock。 */
function createChildProcessMock() {
	const findDirs = [];
	const execFile = (command, args, options, callback) => {
		// collectJsonlFromDirWsl 的调用形状：
		// [ "-d", distro, "-u", user, "find", dir, "-name", "*.jsonl", "-type", "f" ]
		if (Array.isArray(args) && args.includes("find")) {
			const idx = args.indexOf("find");
			findDirs.push(args[idx + 1]);
		}
		// 返回空 stdout：collectJsonlFromDirWsl 解析成 []，listArchived 返回 []
		if (typeof callback === "function") callback(null, "");
	};
	return { execFile, findDirs };
}

function loadSessionScanner(homePath, childProcessExports) {
	const codexMeta = loadModuleInSandbox("src/shared/codexSessionMeta.ts", require);
	const piCompatibility = loadModuleInSandbox("src/shared/piCompatibility.ts", require);
	const fsRetry = loadModuleInSandbox("src/main/utils/fsRetry.ts", require);
	const messageContent = loadModuleInSandbox(
		"src/main/pi/messageContent.ts",
		(id) => {
			if (id.includes("hostInstruction")) return { stripHostInstruction: (t) => t };
			return require(id);
		},
	);
	const sessionSummaryCache = loadModuleInSandbox(
		"src/main/sessions/sessionSummaryCache.ts",
		(id) => {
			if (id === "electron") return { app: { getPath: () => homePath } };
			if (id.includes("fsRetry")) return fsRetry;
			return require(id);
		},
	);
	const wslPaths = loadModuleInSandbox("src/main/wsl/WslPaths.ts", require);
	const sessionNameLine = loadModuleInSandbox("src/main/sessions/sessionNameLine.ts", require);

	return loadModuleInSandbox("src/main/sessions/SessionScanner.ts", (id) => {
		if (id === "electron") {
			return {
				app: { getPath: (key) => (key === "home" ? homePath : join(homePath, String(key))) },
				shell: { trashItem: async () => {} },
			};
		}
		if (id === "node:child_process" || id === "child_process") return childProcessExports;
		if (id.includes("codexSessionMeta")) return codexMeta;
		if (id.includes("piCompatibility")) return piCompatibility;
		if (id.includes("messageContent")) return messageContent;
		if (id.includes("sessionSummaryCache")) return sessionSummaryCache;
		if (id.includes("WslPaths")) return wslPaths;
		if (id.includes("sessionNameLine")) return sessionNameLine;
		if (id.includes("sharedLogger")) return { getAppLogger: () => null };
		return require(id);
	});
}

async function cleanupTempDir(dir) {
	for (let i = 0; i < 5; i++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 60));
		}
	}
}

test("listArchived() before any list() in WSL mode scans the WSL root", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-archive-"));
	const linuxHome = "/home/wsluser";
	try {
		const { execFile, findDirs } = createChildProcessMock();
		const { SessionScanner } = loadSessionScanner(home, { execFile });
		const scanner = new SessionScanner(undefined, home);

		// 切到 WSL：此时 activeScanRoots 仍残留构造时的本机 root（回归根源）
		await scanner.configureWsl({
			distro: "Ubuntu",
			user: "wsluser",
			linuxHome,
			windowsHome: home,
		});

		// 不调用 list()，直接查归档
		await scanner.listArchived();

		// 关键断言：传给 WSL find 的原始参数必须已经是合法 Linux 路径。
		// 禁止在测试端把反斜杠归一化后再接受，否则会掩盖 Windows node:path.join
		// 把 /home/... 改成 \\home\\...、导致 Linux find 实际失败的回归。
		const expectedArchiveDir = `${linuxHome}/.pi/agent/sessions/.pideck-archive`;
		assert.deepEqual(findDirs, [expectedArchiveDir]);
		assert.equal(findDirs[0].includes("\\"), false, "WSL find path must not contain Windows separators");
	} finally {
		await cleanupTempDir(home);
	}
});

test("listArchived() in local mode still scans the local root (no regression)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-local-archive-"));
	try {
		const { execFile, findDirs } = createChildProcessMock();
		const { SessionScanner } = loadSessionScanner(home, { execFile });
		const scanner = new SessionScanner(undefined, home);

		// 本地模式：listArchived 走 collectJsonl（node:fs），不触发 execFile find
		await scanner.listArchived();

		// 本机 root 归档目录存在时才读文件；这里没有 WSL，find 不应被调用
		assert.deepEqual(findDirs, [], "local listArchived should not invoke wsl find");
	} finally {
		await cleanupTempDir(home);
	}
});
