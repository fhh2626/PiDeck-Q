import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const rpcLogger = readFileSync("src/main/logging/RpcLogger.ts", "utf8");
const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");

test("RpcLogger comments match the file layout and write fidelity", () => {
	// 类注释必须写真实目录（homedir/.pi-desktop/logs/rpc），不是 userData/logs/rpc
	assert.doesNotMatch(rpcLogger, /userData\/logs\/rpc/);
	assert.match(rpcLogger, /~\/\.pi-desktop\/logs\/rpc/);
	// 写入不再做「超过 2KB 截断脱敏」，注释不得继续这么写
	assert.doesNotMatch(rpcLogger, /超过 2KB/);
	assert.doesNotMatch(rpcLogger, /MAX_DATA_BYTES/);
	// 真实行为：完整落盘（仅 bash 命令截断为 200 字符），且只在用户为某 Agent 开启时才写
	assert.match(rpcLogger, /文件按原始数据完整落盘/);
	assert.match(rpcLogger, /仅在用户为某个 Agent 打开 RPC 日志时写入/);
	// 唯一的截断实现就是 truncateData，且只处理 bash 命令
	assert.match(rpcLogger, /仅把 bash 命令截断为 200 字符/);
});

test("only the in-memory buffer copy is summarized, and the comment says so", () => {
	// 环形缓冲的副本仍做摘要（防内存膨胀），这是真实存在的「脱敏」语义
	assert.match(rpcLogger, /只影响内存缓冲，不改变落盘内容/);
	const { RpcLogger } = loadTsCommonJs("src/main/logging/RpcLogger.ts");
	const logger = new RpcLogger({ directory: join(tmpdir(), "pideck-rpc-comment-check") });
	const big = "x".repeat(9000);
	logger.push({ id: "1", agentId: "a", time: Date.now(), direction: "recv", method: "m", data: { big } });
	const live = logger.getLive("a");
	assert.equal(JSON.stringify(live[0].data.truncated), "true", "内存缓冲副本必须带 truncated 标记");
	assert.equal(live[0].data.big, undefined, "内存缓冲副本不得保留超限原文");
});

test("archiveDirFor always resolves a directory, so files outside scan roots land in the default root", async () => {
	// 注释曾写「非扫描根内文件返回 undefined」，但 findSessionsRootForFile 总是回退到默认根。
	// 用行为证明：把文件放到扫描根之外的路径再归档，也必须成功落到默认根的归档目录。
	assert.match(scanner, /总是返回一个归档目录：不在任何扫描根内的文件归入默认根/);
	assert.doesNotMatch(scanner, /非扫描根内文件返回 undefined/);

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

test("delete() comments describe the recycle-bin and WSL soft-delete behavior", () => {
	// A4 之后 WSL 走软删除（移入 .pideck-trash），本地走系统回收站；
	// 注释里不得再出现「直接删除文件」这类与实现不符的描述。
	assert.match(scanner, /统一移入系统回收站（可恢复）/);
	assert.match(scanner, /回收站不可用时直接抛错/);
	assert.doesNotMatch(scanner, /删除会话文件，同时清理同级子会话目录[\s\S]{0,200}rmSync/);
});

test("no stale sanitizing claims remain under src/main/logging", () => {
	// 「脱敏」只能用在真实语义上：RpcLogger 里仅内存缓冲副本做摘要替换。
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
