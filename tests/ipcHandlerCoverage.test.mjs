import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 回归：渲染层通过 desktopApi invoke 的每个通道，主进程都必须注册 handler，
// 否则运行时抛 Unknown RPC channel（skills:rename / terminal:shells 曾因此失效）。
test("every desktopApi invoke channel has a registered RPC handler", () => {
	const api = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
	const invoked = new Set([...api.matchAll(/transport\.invoke\(\s*ipcChannels\.(\w+)/g)].map((m) => m[1]));
	const constants = readFileSync("src/shared/ipc.ts", "utf8");
	const names = new Map([...constants.matchAll(/(\w+):\s*"([^"]+)"/g)].map((match) => [match[1], match[2]]));
	const handled = new Set();
	for (const rel of readdirSync("native/backend", { recursive: true })) {
		if (!String(rel).endsWith(".cpp")) continue;
		const source = readFileSync(join("native/backend", rel), "utf8");
		for (const match of source.matchAll(/(?:registry\.add(?:Async)?\(\s*|addCommand\(registry,\s*)QStringLiteral\("([^"]+)"\)/g)) handled.add(match[1]);
	}
	assert.ok(invoked.size > 100, "invoke scan should find the desktop API channels");
	assert.deepEqual([...invoked].filter((key) => !handled.has(names.get(key))).sort(), []);
});
