import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * 已移除功能的边界契约。
 *
 * 5 个「XX 已移除」测试文件合并到这里：每个功能只保留两类断言 ——
 * 相关文件/目录不存在，以及 package.json 不再含相关依赖。
 * 这两类断言是稳定的边界（后人若把功能塞回来会先红），不会随内部实现漂移。
 *
 * 原来那些「某源码文件里不出现某字符串」的断言已删除，理由见各条注释：
 * 它们保护的是「当时那次删除动作」而不是运行时行为，且随实现改名而误报。
 * 迁移类行为（旧字段剥离）另有 tests/settingsMigration.test.mjs 做行为验证。
 */

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

test("feishu integration files and dependency are gone", () => {
	for (const path of [
		"src/main/feishu",
		"src/renderer/src/hooks/useFeishuBridge.ts",
		"src/renderer/src/components/feishu",
	]) {
		assert.equal(existsSync(path), false, `${path} 必须已删除`);
	}
	assert.equal(
		Object.prototype.hasOwnProperty.call(packageJson.dependencies ?? {}, "@larksuiteoapi/node-sdk"),
		false,
		"飞书 SDK 依赖必须已移除",
	);
});

test("anonymous telemetry service files are gone", () => {
	for (const path of [
		"src/main/telemetry/TelemetryService.ts",
		"src/main/telemetry",
	]) {
		assert.equal(existsSync(path), false, `${path} 必须已删除`);
	}
});

test("desktop pet runtime, renderer, and bundled resources are gone", () => {
	for (const path of [
		"src/main/pet",
		"src/renderer/src/pet",
		"src/renderer/pet.html",
		"src/shared/petNotificationLayout.ts",
		"build/pets",
	]) {
		assert.equal(existsSync(path), false, `${path} 必须已删除`);
	}
});

test("browser panel implementation files are gone", () => {
	for (const path of [
		"src/renderer/src/components/app/BrowserPanel.tsx",
		"src/renderer/src/components/workspace/BrowserSurface.tsx",
		"src/main/browser/browserPanelWebviewHost.ts",
		"src/main/browser/browserSecurity.ts",
		"src/main/browser/externalProtocolRequests.ts",
	]) {
		assert.equal(existsSync(path), false, `${path} 必须已删除`);
	}
});

test("the built-in update system files are gone", () => {
	for (const path of [
		"src/main/update/AppUpdateService.ts",
		"src/renderer/src/hooks/useAppUpdateController.ts",
		"src/renderer/src/components/overlays/AppUpdateOverlay.tsx",
		"src/renderer/src/components/app/UpdateModals.tsx",
	]) {
		assert.equal(existsSync(path), false, `${path} 必须已删除`);
	}
	// Pi 环境检测（装没装）不属于更新系统，必须保留
	assert.equal(existsSync("src/renderer/src/hooks/usePiUpdate.ts"), true, "Pi 环境检测 hook 必须保留");
});

test("no removed feature leaves a dependency behind in package.json", () => {
	const all = {
		...packageJson.dependencies,
		...packageJson.devDependencies,
		...packageJson.optionalDependencies,
	};
	for (const name of Object.keys(all)) {
		assert.doesNotMatch(
			name,
			/lark|larksuite|feishu|posthog|telemetry|desktop-pet/i,
			`依赖 ${name} 属于已移除功能，必须一并清理`,
		);
	}
});
