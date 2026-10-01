import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 设置项迁移的行为测试。
 *
 * 原 noUpdateSystem.test.mjs 里的 "settings store strips the legacy
 * disableUpdateCheck from disk" 是在读源码正则，只能证明那行代码还在，
 * 证明不了「旧文件里的字段真会被清掉」。这里改成真的加载 SettingsStore、
 * 写一份带旧字段的 settings.json、跑 load()，再断言内存态与磁盘态。
 */

function loadSettingsStore() {
	return loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: { electron: { app: { getPath: () => tmpdir() } } },
	});
}

/** load() 会 fire-and-forget 触发一次 save()，磁盘落盘需要等一小会儿。 */
async function waitForDiskFieldRemoval(file, field) {
	let onDisk = null;
	for (let i = 0; i < 40; i++) {
		try {
			onDisk = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			await new Promise((r) => setTimeout(r, 10));
			continue;
		}
		if (!Object.prototype.hasOwnProperty.call(onDisk, field)) return onDisk;
		await new Promise((r) => setTimeout(r, 10));
	}
	return onDisk;
}

test("loading settings strips a lone legacy disableUpdateCheck from memory and disk", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-settings-migration-"));
	const settingsFile = join(tempDir, "settings.json");
	try {
		// 只放这一个旧字段：它自己必须能触发一次 save() 把磁盘残留清掉
		writeFileSync(settingsFile, JSON.stringify({ disableUpdateCheck: true }), "utf8");

		const { SettingsStore } = loadSettingsStore();
		const store = new SettingsStore({ desktopSettingsFile: settingsFile, getSystemLocale: () => "en-US" });
		await store.load();

		assert.equal(
			Object.prototype.hasOwnProperty.call(store.get(), "disableUpdateCheck"),
			false,
			"内存态不得保留已移除的字段",
		);

		const onDisk = await waitForDiskFieldRemoval(settingsFile, "disableUpdateCheck");
		assert.ok(onDisk, "settings.json 必须仍然可解析");
		assert.equal(
			Object.prototype.hasOwnProperty.call(onDisk, "disableUpdateCheck"),
			false,
			`磁盘残留的 disableUpdateCheck 必须被清掉，实际：${JSON.stringify(onDisk)}`,
		);
		// 该字段之外的内容不得被误伤
		assert.equal(onDisk.installationType, "portable");
	} finally {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

test("legacy update/telemetry keys do not survive a load-and-save round trip", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-settings-migration-multi-"));
	const settingsFile = join(tempDir, "settings.json");
	try {
		writeFileSync(
			settingsFile,
			JSON.stringify({
				disableUpdateCheck: true,
				telemetryEnabled: true,
				telemetryInstallId: "legacy-id",
				language: "zh-CN",
			}),
			"utf8",
		);

		const { SettingsStore } = loadSettingsStore();
		const store = new SettingsStore({ desktopSettingsFile: settingsFile, getSystemLocale: () => "en-US" });
		await store.load();

		const inMemory = store.get();
		for (const field of ["disableUpdateCheck", "telemetryEnabled", "telemetryInstallId"]) {
			assert.equal(
				Object.prototype.hasOwnProperty.call(inMemory, field),
				false,
				`内存态不得保留已移除的 ${field}`,
			);
		}
		// 仍然支持的字段必须照常生效，迁移不能「一刀切清空」
		assert.equal(inMemory.language, "zh-CN", "正常字段必须在迁移后保留");

		let onDisk = null;
		for (let i = 0; i < 40; i++) {
			onDisk = JSON.parse(readFileSync(settingsFile, "utf8"));
			if (!Object.prototype.hasOwnProperty.call(onDisk, "disableUpdateCheck")) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		assert.equal(Object.prototype.hasOwnProperty.call(onDisk, "disableUpdateCheck"), false);
		assert.equal(onDisk.language, "zh-CN");
	} finally {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});
