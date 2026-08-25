import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 打包契约：resources/extensions/*.ts 的运行时裸导入，pi 扩展加载器只按扩展文件
 * 所在目录向上查 node_modules（见 2026-08-09 线上事故：打包版缺 undici 导致
 * pi 启动即退出 code=1，全部消息发送失败）。因此凡非 node 内置、非 pi 自带
 * （@earendil-works/*）的依赖，都必须经 extraResources 复制进
 * extensions/node_modules/<pkg>，并在 dependencies 中显式声明以保证顶层安装。
 */

// pi 扩展加载器自身可解析的包（实证：打包版成功加载 PiDeck-Q-Ask-Question/todo，
// 仅 undici 解析失败）。新包不在此列时必须先验证打包版能解析再入列。
const PI_PROVIDED = /^(?:@earendil-works\/.*|typebox)$/;

function collectBareImports() {
	const dir = "resources/extensions";
	const specs = new Set();
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
		const source = readFileSync(join(dir, file), "utf8");
		// 逐行匹配，跳过 import type（编译期擦除，不参与运行时解析）
		for (const line of source.split("\n")) {
			if (/^\s*import\s+type\b/.test(line)) continue;
			const m = line.match(/(?:from|import|require\()\s*["']([^"']+)["']/);
			if (!m) continue;
			const spec = m[1];
			if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) continue;
			if (PI_PROVIDED.test(spec)) continue;
			// 裸导入取包名（scoped 取两段）
			const parts = spec.split("/");
			specs.add(parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
		}
	}
	return [...specs];
}

test("extension runtime deps are packaged next to extensions", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const xmake = readFileSync("xmake.lua", "utf8");
	for (const dep of collectBareImports()) {
		assert.match(xmake, new RegExp(`node_modules.*${dep.replace(/[\\/]/g, "[\\\\/]")}`));
		assert.ok(pkg.dependencies?.[dep], `扩展依赖 ${dep} 必须声明在 dependencies`);
		assert.ok(existsSync(join("node_modules", dep, "package.json")), `扩展依赖 ${dep} 未安装`);
	}
});

test("pideck-q-better-compaction keeps its relative runtime files in extraResources", () => {
	const xmake = readFileSync("xmake.lua", "utf8");
	assert.match(xmake, /resources/);
	assert.match(xmake, /os\.cp\(path\.join\(os\.projectdir\(\), "resources", "\*"\)/);
	assert.ok(existsSync(join("resources", "extensions", "pideck-q-better-compaction", "extension-runtime.ts")));
	assert.ok(existsSync(join("resources", "extensions", "pideck-q-better-compaction", "compaction.ts")));
	assert.ok(existsSync(join("resources", "extensions", "pideck-q-better-compaction", "retained-oversize.ts")));
	assert.ok(existsSync(join("resources", "extensions", "pideck-q-better-compaction", "prompts.ts")));
	assert.ok(existsSync(join("resources", "extensions", "pideck-q-better-compaction", "LICENSE")));
});

test("pideck-q-websearch keeps its relative fallback module in extraResources", () => {
	const xmake = readFileSync("xmake.lua", "utf8");
	assert.match(xmake, /resources/);
	assert.ok(existsSync(join("resources", "extensions", "pideck-q-websearch", "extension-runtime.ts")));
	assert.ok(existsSync(join("resources", "extensions", "pideck-q-websearch", "fallback.ts")));
});
