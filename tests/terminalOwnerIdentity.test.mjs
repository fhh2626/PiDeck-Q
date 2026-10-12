import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 本文件只验证 terminalOwnerKeyFor 这一纯函数（路径/身份归一化），
// 不需要真实 pty 原生模块；node-pty 的预编译产物是按安装平台生成的，
// 不桩掉的话在非安装平台上会因缺少原生二进制而无法加载模块。
const { terminalOwnerKeyFor } = loadTsCommonJs("src/main/terminal/TerminalSessionManager.ts", {
	stubs: { "node-pty": {} },
});

const project = (cwd) => ({ kind: "project", projectId: "project", cwd });

test("terminal owner keys preserve case for POSIX and WSL paths", () => {
	assert.notEqual(
		terminalOwnerKeyFor(project("/repo/Foo"), "linux"),
		terminalOwnerKeyFor(project("/repo/foo"), "linux"),
	);
	assert.equal(
		terminalOwnerKeyFor(project("/repo/Foo/"), "linux"),
		terminalOwnerKeyFor(project("/repo/Foo"), "linux"),
	);
	assert.notEqual(
		terminalOwnerKeyFor(project("/repo/foo\\\\bar"), "linux"),
		terminalOwnerKeyFor(project("/repo/foo/bar"), "linux"),
	);
	assert.equal(terminalOwnerKeyFor(project("/"), "linux"), "cwd:/");
	assert.equal(
		terminalOwnerKeyFor(project("C:/Repo"), "win32"),
		terminalOwnerKeyFor(project("c:\\\\repo"), "win32"),
	);
	assert.equal(terminalOwnerKeyFor(project("C:\\\\"), "win32"), "cwd:c:/");
	assert.notEqual(
		terminalOwnerKeyFor(project("\\\\wsl$\\Ubuntu\\home\\Foo"), "win32"),
		terminalOwnerKeyFor(project("\\\\wsl$\\Ubuntu\\home\\foo"), "win32"),
	);
	assert.notEqual(
		terminalOwnerKeyFor(project("\\\\wsl$\\Ubuntu\\home\\Foo"), "win32"),
		terminalOwnerKeyFor(project("\\\\wsl.localhost\\Ubuntu\\home\\Foo"), "win32"),
	);
	assert.equal(
		terminalOwnerKeyFor({ kind: "agent", sessionId: "session", agentId: "agent", runtimeGeneration: 1 }, "linux"),
		"agent:agent",
	);
});
