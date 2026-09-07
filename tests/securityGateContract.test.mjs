import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * 安全门集成契约测试：
 * - 内置扩展清单包含安全门（否则 -e 注入会缺失）
 * - 扩展源文件自包含（不 import PiDeck 源码）
 * - 扩展声明的快照字段与主进程 buildSnapshot 输出一致（schema 契约）
 * - PIDECK_* 环境变量在 PiProcess 启动路径中注入
 */

function loadBuiltInExtensionsModule() {
	const source = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, require, console };
	vm.runInNewContext(outputText, sandbox, { filename: "builtInExtensions.ts" });
	return sandbox.exports;
}

test("BUILT_IN_EXTENSIONS includes pi-deck-security-gate.ts", () => {
	const { BUILT_IN_EXTENSIONS, isBuiltInExtensionName } = loadBuiltInExtensionsModule();
	assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-security-gate.ts"));
	assert.ok(isBuiltInExtensionName("pi-deck-security-gate.ts"));
	assert.ok(!isBuiltInExtensionName("../pi-deck-security-gate.ts"));
});

test("security gate extension is self-contained (no PiDeck src imports)", () => {
	const source = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	assert.doesNotMatch(source, /from\s+["']\.\.?\//);
	assert.doesNotMatch(source, /from\s+["']src\//);
	// 只允许 @earendil-works 与 node 内置模块
	const imports = [...source.matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
	for (const spec of imports) {
		assert.ok(
			spec.startsWith("@earendil-works/") || spec.startsWith("node:") || spec.startsWith("node/"),
			`不允许的扩展依赖: ${spec}`,
		);
	}
});

test("extension reads the same env vars the main process injects", () => {
	const extSource = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	const piProcess = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	const securityTypes = readFileSync("src/shared/types/security.ts", "utf8");
	// 三方必须引用同一对环境变量名
	assert.match(extSource, /process\.env\.PIDECK_SECURITY_CONFIG/);
	assert.match(extSource, /process\.env\.PIDECK_SESSION_ID/);
	assert.match(piProcess, /PIDECK_SECURITY_CONFIG/);
	assert.match(piProcess, /PIDECK_SESSION_ID/);
	assert.match(securityTypes, /PIDECK_SECURITY_CONFIG/);
	assert.match(securityTypes, /PIDECK_SESSION_ID/);
});

test("PIDECK_SESSION_ID is keyed on catalog session id, not sessionPath", () => {
	// 回归：SecurityLevelMenu 用 SessionRecord.id（UUID）保存会话级覆盖，
	// 主进程注入 PIDECK_SESSION_ID 必须用同一个 key（deckSessionId），
	// 否则扩展按 sessionLevels[sessionId] 永远查不到覆盖而回落到全局默认等级。
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
	const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
	assert.match(agentManager, /securitySessionId: securitySessionKey \?\? sessionPath/);
	assert.match(agentManager, /deckSessionId: input\.deckSessionId/);
	assert.match(agentManager, /sessionPath, runtime\.tab\.deckSessionId\)/);
	// 运行时创建 agent 时把 catalog 会话身份透传给 AgentManager
	assert.match(coordinator, /deckSessionId: sessionId/);
	// 类型契约：CreateAgentInput 与 AgentTab 都声明了 deckSessionId
	assert.match(agentTypes, /deckSessionId\?: string/);
});

test("extension snapshot field names match buildSnapshot output", () => {
	// 契约：主进程写入的字段必须被扩展读取。
	// 扩展侧无法 import 主进程模块，靠本测试锁定字段名一致，防止任一侧改名漏同步。
	const extSource = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	const policySource = readFileSync("src/main/security/policy.ts", "utf8");
	for (const field of ["schemaVersion", "enabled", "defaultLevelId", "levels", "sessionLevels"]) {
		assert.match(extSource, new RegExp(`\\b${field}\\b`), `扩展未读取快照字段 ${field}`);
		assert.match(policySource, new RegExp(`\\b${field}\\b`), `主进程未输出快照字段 ${field}`);
	}
});

test("extension reads tool_call input fields that PiDeck built-in tools emit", () => {
	const extSource = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	// read/grep/find/ls 用 path；write/edit 用 filePath；bash 用 command
	assert.match(extSource, /input\.path/);
	assert.match(extSource, /input\.filePath/);
	assert.match(extSource, /input\.command/);
});

test("AgentManager passes security snapshot + session id to PiProcess options", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(agentManager, /securitySnapshotPath:/);
	assert.match(agentManager, /securitySessionId:/);
	assert.match(agentManager, /ensureSnapshotWritten\(\)/);
});

test("preload exposes security namespace with three IPC methods", () => {
	const preload = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	assert.match(preload, /security:\s*\{/);
	assert.match(preload, /securityGetConfig/);
	assert.match(preload, /securityUpdateConfig/);
	assert.match(preload, /securitySetSessionLevel/);
	assert.match(ipc, /security:get-config/);
	assert.match(ipc, /security:update-config/);
	assert.match(ipc, /security:set-session-level/);
});

test("default settings stay zero-intervention (enabled=false)", () => {
	const securityTypes = readFileSync("src/shared/types/security.ts", "utf8");
	assert.match(securityTypes, /enabled:\s*false/);
	assert.match(securityTypes, /defaultLevelId:\s*"standard"/);
	// 快照 schemaVersion 与扩展侧常量一致
	assert.match(securityTypes, /schemaVersion:\s*1/);
});
