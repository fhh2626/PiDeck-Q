import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// 弹框（Dialog/Modal/Overlay）内的外部网页统一通过受控的 system-browser API 打开。
// 保留 forceSystem 参数以维持现有 renderer 调用契约。

test("skill hub result cards force system browser", () => {
	const src = readFileSync("src/renderer/src/config/SkillHubStorePanel.tsx", "utf8");
	// 技能搜索结果卡片：点击跳 skills.sh 网页，必须使用受控的 system-browser API
	assert.match(src, /window\.piDesktop\.app\.openExternal\(\s*`https:\/\/www\.skills\.sh\/search\?q=\$\{encodeURIComponent\(item\.name\)\}`,\s*true\s*\)/);
});

test("extension recommendation cards force system browser", () => {
	const src = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	// 扩展推荐卡片：不得绕过受控的 system-browser API 使用裸 window.open
	assert.doesNotMatch(src, /window\.open\(/);
	assert.match(src, /window\.piDesktop\.app\.openExternal\(\s*`https:\/\/pi\.dev\/packages\/\$\{pkg\.name\}\?name=\$\{packageName\}`,\s*true\s*\)/);
});

test("config diagnostic docs link forces system browser", () => {
	const src = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	assert.match(src, /onOpenDocs=\{\(\) => api\.app\.openExternal\(configDiagnostic\.docsUrl, true\)\}/);
});

test("environment dialog nodejs link forces system browser in both dialog implementations", () => {
	// AppParts 版是当前渲染路径；OverlayComponents 版是 EnvironmentOverlay 兜底路径，一并约束
	for (const file of [
		"src/renderer/src/components/app/AppParts.tsx",
		"src/renderer/src/components/overlays/OverlayComponents.tsx",
	]) {
		const src = readFileSync(file, "utf8");
		assert.match(src, /window\.piDesktop\.app\.openExternal\(\s*"https:\/\/nodejs\.org\/zh-cn\/download\/",\s*true\s*\)/);
	}
});

test("settings web service link forces system browser", () => {
	const src = readFileSync("src/renderer/src/components/app/SettingsFeatureRoot.tsx", "utf8");
	// Web 服务页必须通过受控的 system-browser API 打开；外部端按桌面浏览器视口设计。
	assert.match(src, /onOpenWebService: \(port: string\) => api\.app\.openExternal\(`http:\/\/127\.0\.0\.1:\$\{port\}`, true\)/);
});
