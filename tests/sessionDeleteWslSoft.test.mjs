import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";
import { createFakeWslExecFile } from "./helpers/fakeWslExecFile.mjs";

const ROOT = "/home/u/.pi/agent/sessions";

async function setup() {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-delete-"));
	const fake = createFakeWslExecFile(join(home, "wslfs"));
	const { SessionScanner, isIgnoredSessionScanDirectory } = loadSessionScanner(home, { childProcess: { execFile: fake.execFile } });
	const scanner = new SessionScanner(undefined, home);
	await scanner.configureWsl({ distro: "Ubuntu", user: "u", linuxHome: "/home/u", windowsHome: home });
	const put = (linuxPath, text = "{}\n") => {
		mkdirSync(dirname(fake.host(linuxPath)), { recursive: true });
		writeFileSync(fake.host(linuxPath), text);
	};
	return { home, fake, scanner, put, isIgnoredSessionScanDirectory };
}

test("WSL session delete moves parent and child dir into .pideck-trash instead of rm", async () => {
	const { home, fake, scanner, put } = await setup();
	try {
		put(`${ROOT}/p.jsonl`);
		put(`${ROOT}/p/child.jsonl`, '{"type":"session_info"}\n');

		await scanner.delete(`${ROOT}/p.jsonl`);

		// 原位置必须消失
		assert.equal(existsSync(fake.host(`${ROOT}/p.jsonl`)), false, "父会话文件必须被移走");
		assert.equal(existsSync(fake.host(`${ROOT}/p`)), false, "子会话目录必须被移走");

		// 两者必须落在同一个 .pideck-trash 桶里，内容可恢复
		const buckets = readdirSync(fake.host(`${ROOT}/.pideck-trash`));
		assert.equal(buckets.length, 1, `应当只有一个桶，实际 ${buckets.join(",")}`);
		const bucket = `${ROOT}/.pideck-trash/${buckets[0]}`;
		assert.equal(existsSync(fake.host(`${bucket}/p.jsonl`)), true, "父文件必须可在回收站恢复");
		assert.equal(
			readFileSync(fake.host(`${bucket}/p/child.jsonl`), "utf8"),
			'{"type":"session_info"}\n',
			"子会话内容必须完整保留",
		);

		// delete 绝不能永久删除会话内容
		assert.equal(fake.calls.some((argv) => argv[0] === "rm"), false, "delete must never call rm");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("WSL delete of an already missing session succeeds", async () => {
	const { home, fake, scanner } = await setup();
	try {
		await scanner.delete(`${ROOT}/gone.jsonl`);
		// 不抛错即可；也不该为不存在的会话建桶
		assert.equal(existsSync(fake.host(`${ROOT}/.pideck-trash`)), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test(".pideck-trash is skipped even by archive scans", async () => {
	const { home, isIgnoredSessionScanDirectory } = await setup();
	try {
		assert.equal(isIgnoredSessionScanDirectory(`${ROOT}/.pideck-trash`), true);
		assert.equal(isIgnoredSessionScanDirectory(`${ROOT}/.pideck-trash`, { allowArchive: true }), true);
		assert.equal(isIgnoredSessionScanDirectory(`${ROOT}/.pideck-trash/123/p.jsonl`), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("first WSL archive creates the archive directory", async () => {
	const { home, fake, scanner, put } = await setup();
	try {
		put(`${ROOT}/a.jsonl`);
		const archived = await scanner.archive(`${ROOT}/a.jsonl`);
		assert.ok(existsSync(fake.host(archived)), `归档文件必须存在：${archived}`);
		assert.equal(existsSync(fake.host(`${ROOT}/a.jsonl`)), false, "原位置必须空出来");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("WSL scan ignores sessions sitting inside .pideck-trash", async () => {
	const { home, fake, scanner, put } = await setup();
	try {
		// 造一个含完整会话头的正常会话，以及一个软删除目录里的会话文件
		const session = [
			{ type: "session", id: "live0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/proj" },
			{ type: "message", id: "live0002", parentId: "live0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } },
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		put(`${ROOT}/live.jsonl`, session);
		put(`${ROOT}/.pideck-trash/1/gone.jsonl`, session);

		const summaries = await scanner.list();
		const paths = summaries.map((summary) => summary.filePath);
		assert.equal(paths.some((path) => path.includes(".pideck-trash")), false, "软删除目录内的会话不得出现在列表里");
		assert.equal(paths.includes(`${ROOT}/live.jsonl`), true, "正常会话仍应被扫描到");
		// find 必须显式排除软删除目录，而不是依赖调用方过滤
		const findArgs = fake.calls.find((argv) => argv[0] === "find") ?? [];
		assert.equal(findArgs.some((value) => value.includes(".pideck-trash")), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
