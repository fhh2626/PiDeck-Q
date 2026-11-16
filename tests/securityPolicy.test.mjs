import assert from "node:assert/strict";
import test from "node:test";
import {

	createDefaultSecurityLevels,
} from "../src/shared/types/security.ts";

test("built-in levels satisfy the strict->standard->off severity order", () => {
	const levels = createDefaultSecurityLevels();
	const off = levels.find((l) => l.id === "off");
	const standard = levels.find((l) => l.id === "standard");
	const strict = levels.find((l) => l.id === "strict");
	assert.ok(off && standard && strict, "内置三档等级必须齐全");
	// 关闭：全部放行、无保护
	assert.equal(off.defaultAction, "allow");
	assert.equal(off.protectSensitivePaths, false);
	assert.deepEqual(off.denyBashPatterns, []);
	// 标准：默认放行 + 危险命令确认 + 敏感保护
	assert.equal(standard.defaultAction, "allow");
	assert.equal(standard.toolActions.bash, "ask");
	assert.equal(standard.toolActions.powershell, "ask");
	assert.equal(standard.protectSensitivePaths, true);
	assert.ok(standard.denyBashPatterns.length > 0);
	assert.ok(standard.denyPowerShellPatterns.length > 0);
	// 严格：默认拒绝 + 工作目录边界
	assert.equal(strict.defaultAction, "deny");
	assert.equal(strict.pathPolicy, "workspace");
	assert.equal(strict.protectSensitivePaths, true);
});
