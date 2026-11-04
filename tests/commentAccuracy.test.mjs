import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createAgentManagerHarness } from "./helpers/l2_agentManagerHarness.mjs";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 注释准确性：注释里的「声明」凡是能用行为证明的，都用行为证明（下面的前半部分）；
 * 只有「过时说法不得再出现」这类负向守卫保留为文本断言，因为被守卫的对象本身就是注释文字。
 */

const rpcLogger = readFileSync("src/main/logging/RpcLogger.ts", "utf8");
const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");

/** 用临时目录装载真实 RpcLogger；homedir 被替换以证明默认目录的真实位置。 */
function createRpcLoggerFixture() {
	const home = mkdtempSync(join(tmpdir(), "pideck-rpc-comment-"));
	const { RpcLogger } = loadTsCommonJs("src/main/logging/RpcLogger.ts", {
		stubs: { "node:os": { homedir: () => home } },
	});
	return { home, RpcLogger, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function readRpcLines(directory) {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) => readFileSync(join(directory, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}

test("RpcLogger default directory is <homedir>/.pi-desktop/logs/rpc (not userData/logs/rpc)", () => {
	const fixture = createRpcLoggerFixture();
	try {
		const logger = new fixture.RpcLogger();
		assert.equal(logger.getDirectory(), join(fixture.home, ".pi-desktop", "logs", "rpc"));
	} finally {
		fixture.cleanup();
	}
});

test("RpcLogger writes oversized data to disk in full; only the in-memory copy is summarized", async () => {
	const fixture = createRpcLoggerFixture();
	try {
		const directory = join(fixture.home, "rpc");
		const logger = new fixture.RpcLogger({ directory });
		const big = "x".repeat(9000);
		logger.push({ id: "1", agentId: "a", time: Date.now(), direction: "recv", summary: "s", data: { big } });
		await logger.getFromFile(); // 等待写入队列排空
		const [persisted] = readRpcLines(directory);
		assert.equal(persisted.data.big, big, "落盘必须是完整原始数据，不得截断/摘要");
		assert.equal(persisted.data.truncated, undefined);

		const [live] = logger.getLive("a");
		assert.equal(live.data.truncated, true, "内存缓冲副本必须带 truncated 标记");
		assert.equal(live.data.big, undefined, "内存缓冲副本不得保留超限原文");
	} finally {
		fixture.cleanup();
	}
});

test("RpcLogger truncates only outgoing bash commands to 200 chars on disk; everything else is verbatim", async () => {
	const fixture = createRpcLoggerFixture();
	try {
		const directory = join(fixture.home, "rpc");
		const logger = new fixture.RpcLogger({ directory });
		const now = Date.now();
		const longCommand = "echo ".concat("y".repeat(500));
		const longPrompt = "p".repeat(3000);
		logger.push({ id: "bash", agentId: "a", time: now, direction: "send", summary: "s", data: { type: "bash", command: longCommand, extra: "dropped" } });
		logger.push({ id: "prompt", agentId: "a", time: now, direction: "send", summary: "s", data: { type: "prompt", message: longPrompt } });
		logger.push({ id: "recv-bash", agentId: "a", time: now, direction: "recv", summary: "s", data: { type: "bash", command: longCommand } });
		await logger.getFromFile();
		const byId = new Map(readRpcLines(directory).map((entry) => [entry.id, entry]));
		assert.deepEqual(byId.get("bash").data, { type: "bash", command: longCommand.slice(0, 200) });
		assert.equal(byId.get("prompt").data.message, longPrompt, "非 bash 命令的 prompt 全文不得被截断");
		assert.equal(byId.get("recv-bash").data.command, longCommand, "接收方向不做 bash 截断");
	} finally {
		fixture.cleanup();
	}
});

test("RPC log is written only for agents the user switched RPC logging on for", async (t) => {
	const pushed = [];
	const h = createAgentManagerHarness({ rpcLogger: { push: (entry) => pushed.push(entry) }, noSecurityStore: true });
	t.after(() => h.manager.stopAll());
	const tab = await h.manager.create({ projectId: h.project.id, sessionPath: h.sessionPath });
	const emitRpc = (sequence) => h.processes[0].emit("rpc-log", { direction: "recv", data: { type: "fixture", sequence } });

	emitRpc(1);
	assert.equal(pushed.length, 0, "未开启 RPC 日志的 agent 不得落盘");

	h.manager.setRpcLogging(tab.id, true);
	emitRpc(2);
	assert.equal(pushed.length, 1);
	assert.equal(pushed[0].agentId, tab.id);
	assert.equal(pushed[0].data.sequence, 2);

	h.manager.setRpcLogging(tab.id, false);
	emitRpc(3);
	assert.equal(pushed.length, 1, "关闭后不再写入");
});

test("archiving a file outside every scan root lands in the default root's archive dir", async () => {
	// 注释曾写「非扫描根内文件返回 undefined」，但 findSessionsRootForFile 总是回退到默认根。
	// 用行为证明：把文件放到扫描根之外的路径再归档，也必须成功落到默认根的归档目录。
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-comment-"));
	try {
		// 扫描根是 <home>/.pi/agent/sessions，待归档文件故意放在别处
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const outsidePath = join(home, "somewhere-else", "loose.jsonl");
		mkdirSync(dirname(outsidePath), { recursive: true });
		writeFileSync(
			outsidePath,
			`${JSON.stringify({ type: "session", id: "cccc0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" })}\n`,
			"utf8",
		);

		const { SessionScanner } = loadSessionScanner(home);
		const instance = new SessionScanner(undefined, home);
		await instance.list();

		const archived = await instance.archive(outsidePath);
		assert.ok(
			archived.startsWith(sessionsRoot),
			`扫描根之外的文件必须归入默认根的归档目录，实际：${archived}`,
		);
		assert.ok(archived.includes(".pideck-archive"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("local session delete goes to the recycle bin and refuses to hard-delete when it is unavailable", async () => {
	// 注释声明：本地删除统一移入系统回收站（可恢复）；回收站不可用时直接抛错，不静默硬删。
	// （WSL 路径的 .pideck-trash 软删除行为见 sessionDeleteWslSoft.test.mjs。）
	const home = mkdtempSync(join(tmpdir(), "pideck-delete-comment-"));
	try {
		const sessionPath = join(home, ".pi", "agent", "sessions", "victim.jsonl");
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: "dddd0002", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" })}\n`, "utf8");
		const { SessionScanner } = loadSessionScanner(home);

		const trashed = [];
		await new SessionScanner(undefined, home, async (target, options) => { trashed.push({ target, source: options?.source }); }).delete(sessionPath);
		assert.deepEqual(trashed, [{ target: sessionPath, source: "sessions:delete" }]);

		await assert.rejects(() => new SessionScanner(undefined, home).delete(sessionPath), /Trash service unavailable/);
		assert.equal(existsSync(sessionPath), true, "回收站不可用时文件必须原样保留");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("stale RpcLogger claims do not come back in its comments", () => {
	// 文本断言是对的工具：被守卫的对象就是注释文字本身（行为无法区分一句注释写错）。
	assert.doesNotMatch(rpcLogger, /userData\/logs\/rpc/);
	assert.doesNotMatch(rpcLogger, /超过 2KB/);
	assert.doesNotMatch(rpcLogger, /MAX_DATA_BYTES/);
});

test("stale SessionScanner comments do not come back", () => {
	// 同上：只守卫「已被证伪的旧说法不得复活」，真实行为由上面的行为测试负责。
	assert.doesNotMatch(scanner, /非扫描根内文件返回 undefined/);
	assert.doesNotMatch(scanner, /删除会话文件，同时清理同级子会话目录[\s\S]{0,200}rmSync/);
});

test("no stale sanitizing claims remain under src/main/logging", () => {
	// 「脱敏」只能用在真实语义上：RpcLogger 里仅内存缓冲副本做摘要替换。
	// 文本断言是对的工具：这是对注释措辞的 lint。
	const sources = ["RpcLogger.ts", "AppLogger.ts", "logQuery.ts", "sharedLogger.ts"];
	for (const name of sources) {
		const source = readFileSync(join("src/main/logging", name), "utf8");
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			if (!line.includes("脱敏")) continue;
			assert.ok(
				/内存|缓冲|live|副本/.test(line),
				`${name}:${index + 1} 的「脱敏」描述与实现不符：${line.trim()}`,
			);
		}
	}
});
