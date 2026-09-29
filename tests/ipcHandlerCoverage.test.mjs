import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 回归：渲染层通过 desktopApi invoke 的每个通道，主进程都必须注册 handler，
// 否则运行时抛 Unknown RPC channel（skills:rename / terminal:shells 曾因此失效）。
test("every desktopApi invoke channel has a registered RPC handler", () => {
	const api = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
	const invoked = new Set([...api.matchAll(/transport\.invoke\(\s*ipcChannels\.(\w+)/g)].map((m) => m[1]));
	const handled = new Set();
	for (const rel of readdirSync("src", { recursive: true })) {
		const file = String(rel);
		if (!file.endsWith(".ts")) continue;
		const source = readFileSync(join("src", file), "utf8");
		for (const m of source.matchAll(/\.handle(?:<[^>]*>)?\(\s*ipcChannels\.(\w+)/g)) handled.add(m[1]);
	}
	assert.ok(invoked.size > 100, "invoke scan should find the desktop API channels");
	assert.deepEqual([...invoked].filter((c) => !handled.has(c)).sort(), []);
});
