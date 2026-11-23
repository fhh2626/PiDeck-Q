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
	assert.deepEqual(off.denyPowerShellPatterns, []);
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
	assert.equal(strict.toolActions.powershell, "ask");
	assert.ok(strict.denyPowerShellPatterns.length > 0);
});

for (const key of ["denyBashPatterns", "denyPowerShellPatterns"]) {
	test(`editing a default level's ${key} leaves other levels and future defaults unchanged`, () => {
		const levels = createDefaultSecurityLevels();
		const standard = levels.find((level) => level.id === "standard");
		const strict = levels.find((level) => level.id === "strict");
		const original = [...standard[key]];
		try {
			standard[key].push("custom-test-pattern");
			assert.deepEqual(strict[key], original);
			assert.deepEqual(createDefaultSecurityLevels().find((level) => level.id === "standard")[key], original);
		} finally {
			// Keep a failing pre-fix run from corrupting the exported defaults for another test.
			standard[key].splice(0, standard[key].length, ...original);
		}
	});
}

test("default PowerShell rules match destructive commands regardless of case", () => {
	const standard = createDefaultSecurityLevels().find((level) => level.id === "standard");
	const patterns = standard.denyPowerShellPatterns.map((source) => new RegExp(source, "i"));
	for (const command of [
		"Remove-Item -Recurse ./cache",
		"remove-item -force file.txt",
		"SET-CONTENT output.txt payload",
		"Start-Process powershell",
		"git reset --hard",
		"Write-Output payload > output.txt",
	]) {
		assert.ok(patterns.some((pattern) => pattern.test(command)), command);
	}
	for (const command of ["Get-Content file.txt", "Get-ChildItem", "git status", "Write-Output 'hello'"]) {
		assert.equal(patterns.some((pattern) => pattern.test(command)), false, command);
	}
});
