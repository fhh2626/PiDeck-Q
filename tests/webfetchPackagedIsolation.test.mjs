import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ALLOWED_EXTERNALS = new Set([
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@sinclair/typebox",
]);

test("WebFetch dist/index.mjs import graph: all regular npm dependencies are bundled", () => {
	const distPath = "resources/extensions/pideck-q-webfetch/dist/index.mjs";
	const code = readFileSync(distPath, "utf8");

	const importMatches = [
		...code.matchAll(/^\s*(?:import|export)\s+(?:[\w*\s{},]*from\s+)?["']([^"']+)["']/gm),
	].map((m) => m[1]);

	assert.ok(importMatches.length > 0, "dist/index.mjs must contain module declarations");

	const disallowed = [];
	for (const specifier of importMatches) {
		if (specifier.startsWith("node:")) continue;
		if (ALLOWED_EXTERNALS.has(specifier)) continue;
		disallowed.push(specifier);
	}

	assert.deepEqual(
		disallowed,
		[],
		`WebFetch dist/index.mjs contains unbundled external npm dependencies: ${disallowed.join(", ")}. These must be bundled.`,
	);

	// 确认以前泄露的未打包依赖已被内联
	assert.ok(!code.includes('from "linkedom"'), "linkedom must be bundled into dist/index.mjs");
	assert.ok(!code.includes('from "turndown"'), "turndown must be bundled into dist/index.mjs");
	assert.ok(!code.includes('from "lru-cache"'), "lru-cache must be bundled into dist/index.mjs");
	assert.ok(!code.includes('from "@mozilla/readability"'), "@mozilla/readability must be bundled into dist/index.mjs");
});

test("WebFetch loads in an isolated packaged environment without root node_modules", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-webfetch-iso-"));
	try {
		const extDir = join(tempDir, "resources", "extensions");
		const webfetchDist = join(extDir, "pideck-q-webfetch", "dist");
		mkdirSync(webfetchDist, { recursive: true });

		copyFileSync(
			"resources/extensions/pideck-q-webfetch/dist/index.mjs",
			join(webfetchDist, "index.mjs"),
		);
		copyFileSync(
			"resources/extensions/pideck-q-webfetch.ts",
			join(extDir, "pideck-q-webfetch.ts"),
		);

		// 仅提供 Pi 宿主在运行时对所有插件提供的 peer 依赖桩（模拟宿主环境）
		const stubNodeModules = join(tempDir, "node_modules");

		mkdirSync(join(stubNodeModules, "@earendil-works", "pi-coding-agent"), { recursive: true });
		writeFileSync(
			join(stubNodeModules, "@earendil-works", "pi-coding-agent", "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "index.mjs" }),
		);
		writeFileSync(
			join(stubNodeModules, "@earendil-works", "pi-coding-agent", "index.mjs"),
			"export function keyHint() { return ''; };",
		);

		mkdirSync(join(stubNodeModules, "@earendil-works", "pi-tui"), { recursive: true });
		writeFileSync(
			join(stubNodeModules, "@earendil-works", "pi-tui", "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", main: "index.mjs" }),
		);
		writeFileSync(
			join(stubNodeModules, "@earendil-works", "pi-tui", "index.mjs"),
			"export class Text {};",
		);

		mkdirSync(join(stubNodeModules, "@sinclair", "typebox"), { recursive: true });
		writeFileSync(
			join(stubNodeModules, "@sinclair", "typebox", "package.json"),
			JSON.stringify({ name: "@sinclair/typebox", type: "module", main: "index.mjs" }),
		);
		writeFileSync(
			join(stubNodeModules, "@sinclair", "typebox", "index.mjs"),
			"export const Type = new Proxy({}, { get: () => () => ({}) });",
		);

		// 在没有任何 linkedom, turndown, lru-cache 的干净临时目录下启动子进程进行 import
		const testScript = join(tempDir, "test-load.mjs");
		writeFileSync(
			testScript,
			[
				"import webfetch from './resources/extensions/pideck-q-webfetch/dist/index.mjs';",
				"if (typeof webfetch !== 'function') {",
				"  console.error('Expected webfetch export to be a function, got:', typeof webfetch);",
				"  process.exit(1);",
				"}",
				"console.log('SUCCESS_WEBFETCH_LOADED');",
			].join("\n"),
		);

		const result = spawnSync(process.execPath, [testScript], {
			cwd: tempDir,
			encoding: "utf8",
			env: {
				...process.env,
				NODE_PATH: undefined,
			},
		});

		assert.equal(
			result.status,
			0,
			`WebFetch failed to load in isolated environment:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
		);
		assert.match(result.stdout, /SUCCESS_WEBFETCH_LOADED/);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
