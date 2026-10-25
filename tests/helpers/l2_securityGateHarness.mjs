import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 装载 pi-deck-security-gate 扩展并返回 tool_call 入口。
 *
 * 通过 loadTsCommonJs 的 globals 注入「伪 process」而不是改写真实 process.env，
 * 这样并行/先后执行的测试之间不会互相污染环境变量。
 * env 的形状就是 pi 子进程真正拿到的环境（PiProcess spawn 的 options.env 可原样传入），
 * 用来证明「主进程注入的环境变量名」与「扩展读取的环境变量名」是同一对。
 */
export async function loadGate(env) {
	const gate = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
		globals: { process: { platform: process.platform, env: { ...env } } },
	});
	const handlers = new Map();
	await gate.default({ on: (event, handler) => handlers.set(event, handler) });
	return {
		toolCall: async (event, ctx) => {
			const handler = handlers.get("tool_call");
			if (!handler) throw new Error("tool_call handler not registered");
			return await handler(event, ctx);
		},
	};
}

/** 创建临时目录并提供 writeSnapshot；cleanup 只删除自己创建的目录。 */
export function createSnapshotDir(prefix = "pideck-l2-gate-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return {
		dir,
		writeSnapshot(snapshot, name = "policy.json") {
			const path = join(dir, name);
			writeFileSync(path, JSON.stringify(snapshot), "utf8");
			return path;
		},
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** 构造完整等级对象；overrides 只覆盖测试关心的字段。 */
export function makeLevel(id, overrides = {}) {
	return {
		id,
		name: id,
		description: id,
		toolActions: {},
		denyBashPatterns: [],
		denyPowerShellPatterns: [],
		pathPolicy: "unrestricted",
		customAllowDirs: [],
		denyDirs: [],
		protectSensitivePaths: false,
		defaultAction: "allow",
		...overrides,
	};
}
