import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * CodexSessionImporter 扫描防 OOM 单测。
 *
 * 背景（真实崩溃）：~/.codex/sessions 下 rollouts/ 轨迹文件体积巨大，旧实现 scan()
 * 会 Promise.all 全量并发 readFile + 逐行 JSON.parse，内存峰值随目录总大小线性增长，
 * 扫描时 OOM 被系统静默杀进程（无任何日志）。修复：
 * 1. collectJsonl 跳过 rollouts/ 目录；
 * 2. scan 只读每个文件头部 1MB（session_meta/preview 都在前部），坏行/半行容错；
 * 3. 分块并发（SCAN_CONCURRENCY=6）限制同时驻留的缓冲数；
 * 4. 导入（全量转换）加 IMPORT_MAX_SIZE=80MB 硬上限，超限报错而非 OOM。
 */
function loadTranspiled(sourcePath, sandbox) {
	const source = readFileSync(sourcePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	vm.runInNewContext(outputText, sandbox, { filename: sourcePath });
	return sandbox.exports;
}

function loadImporter(homePath) {
	const codexMeta = loadTranspiled("src/shared/codexSessionMeta.ts", { exports: {} });
	const importCopy = loadTranspiled("src/main/sessions/SessionImportCopy.ts", { exports: {} });
	const sandbox = {
		Buffer,
		exports: {},
		process,
		require: (id) => {
			if (id === "node:os" || id === "os") return { ...require("node:os"), homedir: () => homePath };
			if (id === "electron") return { app: { getPath: () => homePath }, shell: {} };
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "./SessionImportCopy") return importCopy;
			return require(id);
		},
	};
	return loadTranspiled("src/main/sessions/CodexSessionImporter.ts", sandbox);
}

function sessionJsonl(id, cwd) {
	const lines = [];
	lines.push(
		JSON.stringify({
			type: "session_meta",
			payload: { id, cwd, timestamp: "2026-08-10T10:00:00.000Z", model: "gpt-5" },
		}),
	);
	// 两条对话轮次：assistant 回复在前（preview 取第一条非空文本），user 问题在后（title 来源）
	for (let i = 0; i < 2; i++) {
		lines.push(
			JSON.stringify({
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `回复 ${i}` }] },
			}),
		);
		lines.push(
			JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `问题 ${i}` } }),
		);
	}
	return `${lines.join("\n")}\n`;
}

test("codex scan: skips rollouts/ trajectory files", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-rollouts-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(join(sessions, "s1", "rollouts"), { recursive: true });
		// rollouts/ 内的轨迹文件（体积巨大、非独立会话）必须被跳过
		writeFileSync(join(sessions, "s1", "rollouts", "r1.jsonl"), sessionJsonl("r1", project));
		// 非 rollouts 目录的普通会话照常收集
		writeFileSync(join(sessions, "s1", "session.jsonl"), sessionJsonl("s1", project));
		// 根级散落的 .jsonl（非 session 目录结构）也应收集
		writeFileSync(join(sessions, "loose.jsonl"), sessionJsonl("loose", project));

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(project);
		// [...沙箱数组]：vm 内创建的数组原型与测试 realm 不同，deepEqual 会因原型差异误报
		const ids = [...summaries.map((s) => s.id)].sort();
		assert.deepEqual(ids, ["loose", "s1"], "rollouts/ 文件不应出现在扫描结果中");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex scan: oversized file is read head-only, broken lines tolerated", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-big-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		// 超过 1MB 的会话：session_meta 在前部，中后部填充 + 坏 JSON 行
		// （旧实现会全量 parse 到坏行抛错，或直接 OOM）
		const path = join(sessions, "big.jsonl");
		writeFileSync(
			path,
			sessionJsonl("big", project) + "x".repeat(1024 * 1024) + "\n" + '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{broken',
		);

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(project);
		assert.equal(summaries.length, 1, "头部完整的大文件应正常出现在扫描结果");
		assert.equal(summaries[0].id, "big");
		assert.equal(summaries[0].title, "问题 0", "title 取第一条 user 消息（在前部）");
		assert.ok(summaries[0].preview.length > 0, "preview 取第一条非空文本（在前部）");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex scan: small file summary matches full parse (no behavior change)", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-small-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "small.jsonl"), sessionJsonl("small", project));

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(project);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].title, "问题 0");
		assert.equal(summaries[0].preview, "回复 0");
		// 2 user + 2 assistant 消息（converted 内 session/codex_import/model_change 不计入 messageCount）
		assert.equal(summaries[0].messageCount, 4);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex scan: only parses sessions of the selected project", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-projectfilter-"));
	try {
		const projA = join(home, "projA");
		const projB = join(home, "projB");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(join(sessions, "a"), { recursive: true });
		mkdirSync(join(sessions, "b"), { recursive: true });
		// projB 会话正文含坏行：若预过滤失效（旧行为全量解析）该文件会拖慢/报错，
		// 预过滤后 projB 只读头部 64KB 即被丢弃，扫描不受影响
		writeFileSync(join(sessions, "a", "session.jsonl"), sessionJsonl("a", projA));
		writeFileSync(
			join(sessions, "b", "session.jsonl"),
			sessionJsonl("b", projB) + "\n" + '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{broken',
		);

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(projA);
		assert.deepEqual(
			[...summaries.map((s) => s.id)],
			["a"],
			"只应返回当前项目（projA）的会话，projB 的坏正文文件被预过滤跳过",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex scan: meta head filter tolerates broken leading lines", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-scan-metahead-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		// meta 前有坏行（手改/损坏的会话）：预过滤应跳过坏行找到 meta
		writeFileSync(
			join(sessions, "dirty.jsonl"),
			'{"type":"event_msg","payload":{"type":"user_message","message":"前导消息"}}\n' +
				"not-json\n" +
				sessionJsonl("dirty", project),
		);
		// 完全没有 meta 的文件（如手放的数据文件）：应被跳过而不是报错
		writeFileSync(join(sessions, "nometa.jsonl"), "{\"type\":\"response_item\",\"payload\":{}}\n".repeat(4));

		const { CodexSessionImporter } = loadImporter(home);
		const summaries = await new CodexSessionImporter().scan(project);
		assert.deepEqual(
			[...summaries.map((s) => s.id)],
			["dirty"],
			"坏行应被跳过，无 meta 文件应被静默排除",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex import: multi-hundred-MB session streams without loading it whole", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-import-stream-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		const path = join(sessions, "huge.jsonl");
		// 模拟巨型会话：正文含 3 条 10MB 的 function_call_output（~30MB）。
		// 旧全量实现会整文件 readFile + 逐行 JSON.parse（峰值数百 MB，OOM 被系统静默杀进程）；
		// 流式实现只驻留单行，任意大小都能导入。
		const bigOutput = "x".repeat(10 * 1024 * 1024);
		const bigLines = [1, 2, 3].map((n) =>
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "function_call_output",
					call_id: `c${n}`,
					output: bigOutput,
					timestamp: `2026-08-10T10:00:0${n}.000Z`,
				},
			}),
		);
		writeFileSync(path, sessionJsonl("huge", project) + bigLines.join("\n") + "\n");

		const { CodexSessionImporter } = loadImporter(home);
		const report = await new CodexSessionImporter().import(project, [path]);
		assert.equal(report.results[0].success, true);
		// 4 条常规消息（2 assistant + 2 user）+ 3 条 toolResult（大行）
		assert.equal(report.results[0].messageCount, 7);

		// 目标文件结构：头部 3 条固定记录（session/codex_import/model_change）+ 7 消息 + 1 条 session_info
		const targetLines = readFileSync(report.results[0].targetPath, "utf8").trim().split("\n");
		assert.equal(targetLines.length, 3 + 7 + 1);
		assert.deepEqual(
			targetLines.slice(0, 3).map((line) => JSON.parse(line).type),
			["session", "codex_import", "model_change"],
		);
		assert.equal(JSON.parse(targetLines[targetLines.length - 1]).type, "session_info");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex import: failed repeat import preserves the previous target atomically", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-import-atomic-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions");
		mkdirSync(sessions, { recursive: true });
		const sourcePath = join(sessions, "repeat.jsonl");
		writeFileSync(sourcePath, sessionJsonl("repeat", project));

		const { CodexSessionImporter } = loadImporter(home);
		const importer = new CodexSessionImporter();
		const first = await importer.import(project, [sourcePath]);
		assert.equal(first.results[0].success, true);
		const targetPath = first.results[0].targetPath;
		const previous = readFileSync(targetPath, "utf8");

		writeFileSync(sourcePath, sessionJsonl("repeat", project) + "not-json\n");
		const second = await importer.import(project, [sourcePath]);
		assert.equal(second.results[0].success, false);
		assert.equal(readFileSync(targetPath, "utf8"), previous);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
