import assert from "node:assert/strict";
import * as os from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { flushLoadedScanners, loadSessionScanner } from "./helpers/loadSessionScanner.mjs";

// pi 被强杀或写入中途断电时，JSONL 末尾常留下半行；摘要扫描必须跳过坏行，
// 而不是让整个会话从列表里静默消失（且每轮扫描都重读全文）。

const projectPath = "C:\\repo\\project";

function fixture() {
	const home = mkdtempSync(join(os.tmpdir(), "pideck-corrupt-lines-"));
	const dir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
	mkdirSync(dir, { recursive: true });
	return { home, dir };
}

function lines(...entries) {
	return entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n") + "\n";
}

function load(home, fsOverrides = {}) {
	return loadSessionScanner(home, {
		stubs: {
			// 子代理运行记录也在隔离目录里找，避免读到机器真实的 tmp。
			"node:os": { ...os, homedir: () => home, tmpdir: () => home },
			"node:fs/promises": { ...fsPromises, ...fsOverrides },
		},
	}).SessionScanner;
}

test("a session with a truncated or non-object line still appears in the scan", async () => {
	const { home, dir } = fixture();
	try {
		const file = join(dir, "broken.jsonl");
		writeFileSync(file, lines(
			{ type: "session", cwd: projectPath },
			{ type: "message", message: { role: "user", content: "keep me visible" } },
			"null",
			"42",
			'{"type":"message","message":{"role":"assistant","content":"half wri',
		));
		const SessionScanner = load(home);
		const rows = await new SessionScanner(undefined, home, undefined, undefined, home).list(projectPath);
		// 扫描器在 vm 里加载，数组来自另一个 realm；复制到当前 realm 再做结构比较。
		assert.deepEqual(Array.from(rows, (row) => row.filePath), [file]);
		assert.equal(rows[0].messageCount, 1);
		assert.equal(rows[0].preview, "keep me visible");
	} finally {
		await flushLoadedScanners();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a parent-directory session is read once when its project membership is checked", async () => {
	const { home } = fixture();
	try {
		// 在 home 启动 pi 再操作子项目的历史会话：cwd 是父目录，需要看正文是否提到当前项目。
		const dir = join(home, ".pi", "agent", "sessions", "--C--repo--");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "parent.jsonl");
		writeFileSync(file, lines(
			{ type: "session", cwd: "C:\\repo" },
			{ type: "message", message: { role: "user", content: "work on C:/repo/project please" } },
		));
		let bodyReads = 0;
		const SessionScanner = load(home, {
			readFile: async (path, options) => {
				if (String(path).endsWith("parent.jsonl")) bodyReads += 1;
				return fsPromises.readFile(path, options);
			},
		});
		const rows = await new SessionScanner(undefined, home, undefined, undefined, home).list(projectPath);
		assert.deepEqual(Array.from(rows, (row) => row.filePath), [file]);
		assert.equal(bodyReads, 1, "summary and membership must share one body read");
	} finally {
		await flushLoadedScanners();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a session with a corrupt line is cached and not re-read on the next scan", async () => {
	const { home, dir } = fixture();
	try {
		const file = join(dir, "broken.jsonl");
		writeFileSync(file, lines({ type: "session", cwd: projectPath }, "{not json"));
		let bodyReads = 0;
		const SessionScanner = load(home, {
			readFile: async (path, options) => {
				if (String(path).endsWith("broken.jsonl")) bodyReads += 1;
				return fsPromises.readFile(path, options);
			},
		});
		const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
		assert.equal((await scanner.list(projectPath)).length, 1);
		assert.equal((await scanner.list(projectPath)).length, 1);
		assert.equal(bodyReads, 1, "the unchanged file must be served from the summary cache");
	} finally {
		await flushLoadedScanners();
		rmSync(home, { recursive: true, force: true });
	}
});
