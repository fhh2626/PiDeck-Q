import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatBytes, formatMb } from "../src/shared/formatBytes.ts";

test("formatBytes: human readable units", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(1024), "1.0 KB");
	assert.equal(formatBytes(1048576), "1.0 MB");
	assert.equal(formatBytes(1073741824), "1.00 GB");
	assert.equal(formatBytes(-1), "-");
	assert.equal(formatBytes(Number.NaN), "-");
});

test("formatMb: fixed MB unit for process monitor", () => {
	assert.equal(formatMb(0), "0.0 MB");
	assert.equal(formatMb(1048576), "1.0 MB");
	assert.equal(formatMb(524288), "0.5 MB");
	assert.equal(formatMb(123456789), "117.7 MB");
	assert.equal(formatMb(-1), "-");
	assert.equal(formatMb(Number.NaN), "-");
});

test("ProcessMetricsTab wires table columns and refresh", () => {
	const source = readFileSync("src/renderer/src/components/app/settings/ProcessMetricsTab.tsx", "utf8");
	assert.match(source, /window\.piDesktop\.system\.getProcessMetrics\(\)/);
	// 只展示 pi agent 行；不再渲染 Electron 进程表（类型/专用内存口径均已移除）
	assert.doesNotMatch(source, /processTypeLabel/);
	assert.doesNotMatch(source, /privateBytes/);
	assert.match(source, /formatMb\(agentTotal\)/);
	assert.match(source, /t\("config\.process\.refresh"\)/);
	assert.match(source, /agent\.agentId/);
	assert.match(source, /t\("config\.process\.empty"\)/);
});

test("SettingsModal registers process tab; ConfigModal no longer hosts it", () => {
	const settings = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
	const config = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	// 进程监控已从 Pi 管理界面迁入设置：SettingsModal 注册 tab，ConfigModal 移除
	assert.match(settings, /id: "process"/);
	assert.match(settings, /<TabsContent value="process"/);
	assert.match(settings, /t\("settings\.tabs\.process"\)/);
	assert.match(settings, /<ProcessMetricsTab \/>/);
	assert.doesNotMatch(config, /value="process"/);
	assert.doesNotMatch(config, /ProcessMetricsTab/);
});

test("process monitor i18n keys exist in zh-CN and en-US", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const keys = [
		"settings.tabs.process",
		"config.process.refresh",
		"config.process.agentCount",
		"config.process.agentTotal",
		"config.process.sampledAt",
		"config.process.agentSection",
		"config.process.empty",
		"config.process.loadFailed",
		"config.process.column.memory",
		"config.process.column.agentId",
		"config.process.column.session",
		"config.process.column.action",
		"config.process.stop",
		"config.process.stopConfirm",
		"config.process.stopped",
		"config.process.stopFailed",
	];
	for (const key of keys) {
		assert.match(zh, new RegExp(`"${key}":`), `zh-CN missing ${key}`);
		assert.match(en, new RegExp(`"${key}":`), `en-US missing ${key}`);
	}
});
