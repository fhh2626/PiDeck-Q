import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("Feishu bot integration is removed from runtime contracts and menus", () => {
	const main = readFileSync("src/native-node/index.ts", "utf8");
	const preload = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const settings = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
	const packageJson = readFileSync("package.json", "utf8");

	assert.equal(existsSync("src/main/feishu"), false);
	assert.equal(existsSync("src/renderer/src/hooks/useFeishuBridge.ts"), false);
	assert.equal(existsSync("src/renderer/src/components/feishu"), false);
	assert.doesNotMatch(main, /Feishu|feishu|飞书/);
	assert.doesNotMatch(preload, /Feishu|feishu/);
	assert.doesNotMatch(ipc, /feishu/i);
	assert.doesNotMatch(settings, /ImTab|settings\.tabs\.im|id: "im"/);
	assert.doesNotMatch(packageJson, /larksuiteoapi/);
});
