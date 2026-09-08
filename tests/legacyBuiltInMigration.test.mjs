import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * 旧全局入口迁移的行为契约（真实临时目录）。
 *
 * 核心红线：**PiDeck 不得删除自己不认识的扩展文件**。同名文件可能来自用户自己
 * 的 fork，也可能是一个先于 PiDeck 存在的自用版本；扩展目录下的 .ts 会被 pi 直接
 * 加载，误删 = 破坏用户源码，且发生在用户毫无察觉的启动路径上。
 *
 * 因此迁移只在「多条独立证据同时命中」时执行，且必须先把原文备份到
 * `<agentDir>/pideck-backups/<version>/`（extensions/ 自动发现目录之外）。
 */

const moduleCache = new Map();

function loadModule() {
	const filePath = resolve("src/main/extensions/legacyBuiltInMigration.ts");
	if (moduleCache.has(filePath)) return moduleCache.get(filePath);
	const outputText = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const sandbox = {
		exports: {},
		require: (id) => (id.startsWith("./") ? require(resolve(id)) : require(id)),
		process,
		console,
	};
	moduleCache.set(filePath, sandbox.exports);
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

/** 命中 self-use-shim 指纹：PiDeck 本机自用版确实写下过这一形态。 */
const SELF_USE_SHIM = [
	"/**",
	" * Pi prompt replacement extension.",
	" *",
	" * Implementation: ./change-pi-prompt/runtime.ts",
	" */",
	"import { registerPromptExtension } from './change-pi-prompt/runtime.ts';",
	"export default (pi) => registerPromptExtension(pi);",
	"",
].join("\n");

/** 用户自己写的、恰好同名的扩展：绝不可被动。 */
const UNKNOWN_FILE = [
	"import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
	"export default (pi: ExtensionAPI) => {",
	"  pi.on('before_agent_start', () => ({ systemPrompt: 'mine' }));",
	"};",
	"",
].join("\n");

/**
 * 早期“自带完整实现”的自用版（含 os/spawnSync 平台探测）。
 * 它可能先于 PiDeck 存在于用户环境，归属不由 PiDeck 单方面判定 → 必须保留。
 */
const ORIGINAL_SELF_IMPLEMENTATION = [
	"import os from \"node:os\";",
	"import { spawnSync } from \"node:child_process\";",
	"const CUSTOM_IDENTITY = \"You are Pi, an open-source and customizable coding agent.\";",
	"export default (pi) => {};",
	"",
].join("\n");

async function makeAgentDir() {
	const root = await mkdtemp(join(tmpdir(), "pideck-legacy-mig-"));
	const agentDir = join(root, ".pi", "agent");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	return { root, agentDir, entry: join(agentDir, "extensions", "change-pi-prompt.ts") };
}

/** 模块在 vm sandbox 里求值，数组带 sandbox realm 原型，deepStrictEqual 会误判。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

const { identifyLegacyBuiltInEntry, migrateLegacyBuiltInEntries, getLegacyBuiltInEntryRules } =
	loadModule();

test("recognizes the PiDeck-authored shim and nothing else", () => {
	assert.equal(identifyLegacyBuiltInEntry("change-pi-prompt.ts", SELF_USE_SHIM), "self-use-shim");
	// 未知来源：用户自有实现、早期自带实现的自用版
	assert.equal(identifyLegacyBuiltInEntry("change-pi-prompt.ts", UNKNOWN_FILE), null);
	assert.equal(identifyLegacyBuiltInEntry("change-pi-prompt.ts", ORIGINAL_SELF_IMPLEMENTATION), null);
	// 单条证据不足：只提 registerPromptExtension 不算
	assert.equal(identifyLegacyBuiltInEntry("change-pi-prompt.ts", "registerPromptExtension;"), null);
	// 只有相对 import、缺头部说明 → 不足以判定归属
	assert.equal(
		identifyLegacyBuiltInEntry(
			"change-pi-prompt.ts",
			"import { registerPromptExtension } from './change-pi-prompt/runtime.ts';",
		),
		null,
	);
	// 规则未覆盖的文件名一律不碰
	assert.equal(identifyLegacyBuiltInEntry("my-own.ts", SELF_USE_SHIM), null);
});

test("missing legacy entry is a no-op", async () => {
	const { agentDir } = await makeAgentDir();
	const outcome = plain(await migrateLegacyBuiltInEntries([agentDir], "0.2.1"));
	assert.deepEqual(outcome.moved, []);
	assert.deepEqual(outcome.preserved, []);
	assert.deepEqual(outcome.warnings, []);
});

test("recognized shim is moved to the versioned backup directory", async () => {
	const { agentDir, entry } = await makeAgentDir();
	await writeFile(entry, SELF_USE_SHIM, "utf8");

	const outcome = plain(await migrateLegacyBuiltInEntries([agentDir], "0.2.1"));

	assert.equal(outcome.moved.length, 1);
	assert.equal(outcome.moved[0].fingerprint, "self-use-shim");
	assert.ok(!existsSync(entry), "legacy entry must leave the auto-discovered dir");
	const backup = outcome.moved[0].backup;
	assert.ok(backup.includes(join("pideck-backups", "0.2.1")), `unexpected backup path: ${backup}`);
	// 备份必须落在 extensions 自动发现目录之外，否则会被 pi 再次加载
	assert.ok(!backup.includes(join("agent", "extensions")), `backup inside discovery dir: ${backup}`);
	assert.equal(await readFile(backup, "utf8"), SELF_USE_SHIM, "backup must equal the original byte-for-byte");
	assert.deepEqual(outcome.preserved, []);
	assert.deepEqual(outcome.warnings, []);
});

test("unknown same-name file is preserved with a warning and never deleted", async () => {
	const { agentDir, entry } = await makeAgentDir();
	await writeFile(entry, UNKNOWN_FILE, "utf8");

	const outcome = plain(await migrateLegacyBuiltInEntries([agentDir], "0.2.1"));

	assert.deepEqual(outcome.moved, []);
	assert.ok(existsSync(entry), "user-owned file must survive migration");
	assert.equal(await readFile(entry, "utf8"), UNKNOWN_FILE);
	assert.equal(outcome.preserved.length, 1);
	assert.equal(outcome.preserved[0].reason, "unknown");
	assert.equal(outcome.warnings.length, 1);
	// 告警要讲清代价（双加载）和自助处置方式
	assert.match(outcome.warnings[0], /rename or remove/i);
	assert.match(outcome.warnings[0], /pideck-q-change-pi-prompt/);
});

test("the pre-existing self-implemented entry is preserved, not claimed as ours", async () => {
	const { agentDir, entry } = await makeAgentDir();
	await writeFile(entry, ORIGINAL_SELF_IMPLEMENTATION, "utf8");

	const outcome = plain(await migrateLegacyBuiltInEntries([agentDir], "0.2.1"));

	assert.deepEqual(outcome.moved, [], "PiDeck must not claim ownership of the original self-use file");
	assert.ok(existsSync(entry));
});

test("backup name collision appends a suffix instead of overwriting history", async () => {
	const { agentDir, entry } = await makeAgentDir();
	const backupDir = join(agentDir, "pideck-backups", "0.2.1");
	await mkdir(backupDir, { recursive: true });
	const first = join(backupDir, "change-pi-prompt.ts");
	// 上一次运行留下的同名备份，内容不同，绝不能被覆盖
	await writeFile(first, "// previous run\n", "utf8");
	await writeFile(entry, SELF_USE_SHIM, "utf8");

	const outcome = plain(await migrateLegacyBuiltInEntries([agentDir], "0.2.1"));

	assert.equal(outcome.moved.length, 1);
	assert.notEqual(outcome.moved[0].backup, first, "collision must produce a different file name");
	assert.equal(await readFile(first, "utf8"), "// previous run\n", "existing backup must stay intact");
	assert.equal(await readFile(outcome.moved[0].backup, "utf8"), SELF_USE_SHIM);
});

test("migration is idempotent across repeated startups", async () => {
	const { agentDir, entry } = await makeAgentDir();
	await writeFile(entry, SELF_USE_SHIM, "utf8");

	await migrateLegacyBuiltInEntries([agentDir], "0.2.1");
	const second = plain(await migrateLegacyBuiltInEntries([agentDir], "0.2.1"));

	assert.deepEqual(second.moved, []);
	assert.deepEqual(second.preserved, []);
	assert.ok(!existsSync(entry));
});

test("each agent dir is migrated independently (local + WSL)", async () => {
	const local = await makeAgentDir();
	const wsl = await makeAgentDir();
	await writeFile(local.entry, SELF_USE_SHIM, "utf8");
	await writeFile(wsl.entry, SELF_USE_SHIM, "utf8");

	const outcome = plain(await migrateLegacyBuiltInEntries([local.agentDir, wsl.agentDir], "0.2.1"));

	assert.equal(outcome.moved.length, 2);
	assert.ok(!existsSync(local.entry));
	assert.ok(!existsSync(wsl.entry));
	// 各自备份到本目录的 pideck-backups 下，不串台
	assert.ok(outcome.moved.some((m) => m.backup.includes(local.agentDir)));
	assert.ok(outcome.moved.some((m) => m.backup.includes(wsl.agentDir)));
});

test("one dir's unrecognized file does not block another dir's migration", async () => {
	const local = await makeAgentDir();
	const wsl = await makeAgentDir();
	await writeFile(local.entry, SELF_USE_SHIM, "utf8");
	await writeFile(wsl.entry, UNKNOWN_FILE, "utf8");

	const outcome = plain(await migrateLegacyBuiltInEntries([local.agentDir, wsl.agentDir], "0.2.1"));

	assert.equal(outcome.moved.length, 1);
	assert.equal(outcome.preserved.length, 1);
	assert.ok(!existsSync(local.entry));
	assert.ok(existsSync(wsl.entry));
});

test("a path that is not a regular file is never removed", async () => {
	const { agentDir } = await makeAgentDir();
	// 目录冒充入口文件：isFile() 为假，必须走“保留”而不是 rm
	const asDir = join(agentDir, "extensions", "change-pi-prompt.ts");
	await mkdir(asDir, { recursive: true });

	const outcome = plain(await migrateLegacyBuiltInEntries([agentDir], "0.2.1"));

	assert.deepEqual(outcome.moved, []);
	assert.ok(existsSync(asDir), "non-file path must not be removed");
	assert.ok((await stat(asDir)).isDirectory());
});

test("files outside the fingerprint rules are untouched", async () => {
	const { agentDir } = await makeAgentDir();
	// 只在注释里提到内置 runtime 路径：证据不完整
	await writeFile(
		join(agentDir, "extensions", "change-pi-prompt.ts"),
		"// pideck-q-change-pi-prompt/runtime.ts referenced in a comment only\nexport default () => {};\n",
		"utf8",
	);
	// PiDeck 自有内置扩展副本：属于 backendStartupTasks 的直接清理范围，本模块不越权
	await writeFile(join(agentDir, "extensions", "pi-deck-todo.ts"), "export default () => {};\n", "utf8");

	const outcome = plain(await migrateLegacyBuiltInEntries([agentDir], "0.2.1"));

	assert.deepEqual(outcome.moved, []);
	assert.equal(outcome.preserved.length, 1);
	assert.equal(
		existsSync(join(agentDir, "extensions", "pi-deck-todo.ts")),
		true,
		"this module must only touch files covered by its own rules",
	);
	assert.deepEqual(plain(getLegacyBuiltInEntryRules().map((rule) => rule.fileName)), [
		"change-pi-prompt.ts",
	]);
});
