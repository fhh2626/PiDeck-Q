import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// Claude Code 的 JSONL 同样可能被截断；单个坏行不能让整份会话无法扫描/导入，
// 超长会话（数十万条带时间戳的记录）也不能因展开参数而 RangeError。

const projectPath = "C:\\repo\\project";

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "pideck-claude-import-"));
	const dir = join(home, ".claude", "projects", "C--repo-project");
	mkdirSync(dir, { recursive: true });
	return { home, dir };
}

function load(fsOverrides = {}) {
	const { ClaudeSessionImporter } = loadTsCommonJs("src/main/sessions/ClaudeSessionImporter.ts", {
		stubs: { "node:fs/promises": { ...fsPromises, ...fsOverrides } },
	});
	return ClaudeSessionImporter;
}

const user = (text, timestamp) => JSON.stringify({
	type: "user", sessionId: "claude-1", cwd: projectPath, timestamp,
	message: { role: "user", content: text },
});

test("a Claude session with a truncated line is still listed with its valid content", async () => {
	const { home, dir } = fixture();
	try {
		writeFileSync(join(dir, "s.jsonl"), [
			user("hello from claude", "2024-01-01T00:00:00.000Z"),
			"null",
			'{"type":"assistant","message":{"role":"assist',
		].join("\n") + "\n");
		const ClaudeSessionImporter = load();
		const rows = await new ClaudeSessionImporter(undefined, home).scan(projectPath);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].id, "claude-1");
		assert.equal(rows[0].createdAt, Date.parse("2024-01-01T00:00:00.000Z"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a very long Claude session does not overflow the timestamp range computation", async () => {
	const { home, dir } = fixture();
	try {
		const count = 200_000;
		const base = Date.parse("2024-01-01T00:00:00.000Z");
		const lines = [user("start", new Date(base + 1000).toISOString())];
		for (let index = 0; index < count; index += 1) {
			lines.push(JSON.stringify({ type: "progress", timestamp: new Date(base + 2000 + index).toISOString() }));
		}
		lines.push(JSON.stringify({ type: "progress", timestamp: new Date(base).toISOString() }));
		writeFileSync(join(dir, "long.jsonl"), lines.join("\n") + "\n");
		const ClaudeSessionImporter = load();
		const rows = await new ClaudeSessionImporter(undefined, home).scan(projectPath);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].createdAt, base);
		assert.equal(rows[0].updatedAt, base + 2000 + count - 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("scanning many Claude sessions reads a bounded number of files at once", async () => {
	const { home, dir } = fixture();
	try {
		for (let index = 0; index < 40; index += 1) {
			writeFileSync(join(dir, `s${index}.jsonl`), user(`hi ${index}`, new Date(1704067200000 + index).toISOString()).replace("claude-1", `claude-${index}`) + "\n");
		}
		let active = 0;
		let maxActive = 0;
		const ClaudeSessionImporter = load({
			readFile: async (path, options) => {
				const source = String(path).includes(".claude");
				if (source) { active += 1; maxActive = Math.max(maxActive, active); }
				try {
					await new Promise((resolve) => setTimeout(resolve, 2));
					return await fsPromises.readFile(path, options);
				} finally { if (source) active -= 1; }
			},
		});
		const rows = await new ClaudeSessionImporter(undefined, home).scan(projectPath);
		assert.equal(rows.length, 40);
		assert.ok(maxActive <= 8, `expected at most 8 concurrent source reads, saw ${maxActive}`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
