import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLastWindowBounds, saveLastWindowBounds } from "../src/main/windowState.ts";

/**
 * 窗口 normal bounds 记忆（startupWindowMode="last"）存储层测试：
 * 保存/读取位置与尺寸/旧格式兼容/损坏容错/最小尺寸校验。
 */
test("windowState: save then read returns the same bounds", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { width: 1360, height: 800 });
		assert.deepEqual(readLastWindowBounds(dir), { width: 1360, height: 800 });
		// 写入文件为 JSON 格式（后续人工排查/清理可读）
		assert.match(readFileSync(join(dir, "last-window-bounds.json"), "utf8"), /"width":1360/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: save then read preserves negative and fractional positions", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { x: -1920.4, y: 72.6, width: 1360.7, height: 800.2 });
		assert.deepEqual(readLastWindowBounds(dir), {
			x: -1920,
			y: 73,
			width: 1361,
			height: 800,
		});
		assert.match(readFileSync(join(dir, "last-window-bounds.json"), "utf8"), /"x":-1920/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: legacy size-only files remain readable", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		writeFileSync(join(dir, "last-window-bounds.json"), JSON.stringify({ width: 1200, height: 700 }), "utf8");
		assert.deepEqual(readLastWindowBounds(dir), { width: 1200, height: 700 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: partial position is ignored without invalidating the size", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		writeFileSync(join(dir, "last-window-bounds.json"), JSON.stringify({ width: 1200, height: 700, x: 40 }), "utf8");
		assert.deepEqual(readLastWindowBounds(dir), { width: 1200, height: 700 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: missing file returns null (fallback to default mode)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		assert.equal(readLastWindowBounds(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: corrupted JSON returns null", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { width: 1200, height: 700 });
		const file = join(dir, "last-window-bounds.json");
		writeFileSync(file, "{not-json", "utf8");
		assert.equal(readLastWindowBounds(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: bounds below minimum window size are rejected", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { width: 600, height: 400 });
		assert.equal(readLastWindowBounds(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowState: fractional bounds are rounded on save", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ws-"));
	try {
		saveLastWindowBounds(dir, { width: 1360.7, height: 800.2 });
		assert.deepEqual(readLastWindowBounds(dir), { width: 1361, height: 800 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
