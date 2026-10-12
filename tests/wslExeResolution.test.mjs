import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
const locator = readFileSync("src/main/pi/PiLocator.ts", "utf8");

test("wsl.exe lookup lives only in src/main/wsl/wslExe.ts", () => {
	// 三份各自的查找逻辑（含每次 existsSync 与 console.log）合并为一份带缓存的实现。
	for (const [name, source] of [["SessionScanner", scanner], ["PiLocator", locator]]) {
		assert.doesNotMatch(
			source,
			/private resolveWslExe\(\)/,
			`${name} 不得再自带 resolveWslExe 查找逻辑`,
		);
		assert.match(source, /getWslExe\(\)/, `${name} 必须改用共享的 getWslExe()`);
	}
	// 仅 System32 找不到 wsl.exe 时才回退 shell 模式；这段判断现在只有一处。
	const resolver = readFileSync("src/main/wsl/wslExe.ts", "utf8");
	assert.match(resolver, /Sysnative/);
	assert.match(resolver, /shell: true/);
});

test("both call sites ask the shared resolver for the shell mode", () => {
	// SessionScanner 的两个 getter 都经共享解析器，不再各自 existsSync。
	assert.match(scanner, /private get wslExePath\(\): string \{\s*return getWslExe\(\)\.command;/);
	assert.match(scanner, /private get wslShell\(\): boolean \{\s*return getWslExe\(\)\.shell;/);
	assert.doesNotMatch(scanner, /@deprecated/);
	// PiLocator 三处调用点全部改为共享解析器。
	assert.doesNotMatch(locator, /this\.resolveWslExe\(\)/);
	assert.equal((locator.match(/getWslExe\(\)/g) ?? []).length >= 3, true, "PiLocator 的三处调用点都要改用 getWslExe()");
});

test("the shared resolver caches its result instead of probing every call", () => {
	const { getWslExe } = loadTsCommonJs("src/main/wsl/wslExe.ts");
	const first = getWslExe();
	const second = getWslExe();
	assert.equal(first, second, "同一进程内必须返回同一个缓存对象");
	assert.equal(typeof first.command, "string");
	assert.equal(typeof first.shell, "boolean");
});
