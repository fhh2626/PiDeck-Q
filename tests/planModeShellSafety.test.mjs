import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadPlanModeModule() {
	const source = readFileSync("resources/extensions/pi-deck-plan-mode.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});

	const sandbox = {
		exports: {},
		require,
		console,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "pi-deck-plan-mode.ts" });
	return sandbox.exports;
}

test("getPlanModeTools disables subagent, edit and write while preserving shell and read tools", () => {
	const { getPlanModeTools } = loadPlanModeModule();

	const toolsWithSubagent = [
		"read",
		"powershell",
		"edit",
		"write",
		"subagent",
	];
	const planTools = getPlanModeTools(toolsWithSubagent);

	assert.ok(planTools.includes("read"), "Plan tools must include read");
	assert.ok(planTools.includes("powershell"), "Plan tools must keep existing powershell");
	assert.ok(!planTools.includes("edit"), "Plan tools must not include edit");
	assert.ok(!planTools.includes("write"), "Plan tools must not include write");
	assert.ok(!planTools.includes("subagent"), "Plan tools must not include subagent to prevent indirect writes");
	assert.ok(!planTools.includes("bash"), "Plan tools must not hallucinate bash");

	const inputWithGrep = [
		"read",
		"grep",
		"powershell",
		"edit",
		"write",
		"subagent",
	];
	const resultWithGrep = getPlanModeTools(inputWithGrep);
	assert.equal(resultWithGrep.includes("read"), true);
	assert.equal(resultWithGrep.includes("grep"), true);
	assert.equal(resultWithGrep.includes("powershell"), true);
	assert.equal(resultWithGrep.includes("edit"), false);
	assert.equal(resultWithGrep.includes("write"), false);
	assert.equal(resultWithGrep.includes("subagent"), false);
	assert.equal(resultWithGrep.includes("bash"), false);

	// 保留 bash（如果原本就有）
	const inputWithBash = ["read", "bash", "edit", "write", "subagent"];
	const resultWithBash = getPlanModeTools(inputWithBash);
	assert.equal(resultWithBash.includes("read"), true);
	assert.equal(resultWithBash.includes("bash"), true);
	assert.equal(resultWithBash.includes("subagent"), false);
	assert.equal(resultWithBash.includes("edit"), false);
	assert.equal(resultWithBash.includes("write"), false);
});

test("entering and exiting plan mode preserves and restores subagent via toolsBeforePlanMode", async () => {
	const { default: planModeExtension } = loadPlanModeModule();

	const handlers = new Map();
	const commands = new Map();
	let currentTools = ["read", "grep", "powershell", "edit", "write", "subagent"];
	const fakePi = {
		on: (event, handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name, def) => {
			commands.set(name, def.handler);
		},
		appendEntry: () => {},
		getActiveTools: () => currentTools,
		setActiveTools: (tools) => {
			currentTools = tools;
		},
	};

	planModeExtension(fakePi);

	const inputHandler = handlers.get("input");
	const planCommandHandler = commands.get("plan");
	assert.ok(planCommandHandler, "plan command must be registered");

	const ctx = {
		ui: {
			setWidget: () => {},
			notify: () => {},
			select: async () => "stay",
		},
	};

	// 进入 plan 模式
	await inputHandler({ text: "__PI_DECK_PLAN_MODE__ explore things" }, ctx);
	assert.ok(!currentTools.includes("subagent"), "subagent must be removed in plan mode");
	assert.ok(!currentTools.includes("edit"), "edit must be removed in plan mode");
	assert.ok(!currentTools.includes("write"), "write must be removed in plan mode");
	assert.ok(currentTools.includes("read"), "read must remain");
	assert.ok(currentTools.includes("powershell"), "powershell must remain");

	// 关闭 plan mode
	await planCommandHandler("off", ctx);
	assert.ok(currentTools.includes("subagent"), "subagent must be restored upon exiting plan mode");
	assert.ok(currentTools.includes("edit"), "edit must be restored upon exiting plan mode");
	assert.ok(currentTools.includes("write"), "write must be restored upon exiting plan mode");
	assert.ok(currentTools.includes("powershell"), "powershell must be restored upon exiting plan mode");
});

test("getPlanModeTools preserves active shell without hallucinating bash", () => {
	const { getPlanModeTools, getNormalModeTools } = loadPlanModeModule();

	// 1. 只有 powershell：进入 Plan 模式只禁 edit/write，保留 powershell，不凭空注入 bash
	const pwshTools = ["read", "powershell", "edit", "write", "ask_question"];
	const planTools1 = [...getPlanModeTools(pwshTools)];
	assert.deepEqual(planTools1, ["read", "powershell", "ask_question"]);
	assert.ok(!planTools1.includes("bash"), "Plan mode must not inject bash when only powershell exists");

	// 退出 Plan 模式恢复写工具，仍然没有 bash
	const normalTools1 = [...getNormalModeTools(planTools1)];
	assert.deepEqual(normalTools1, ["read", "powershell", "ask_question", "edit", "write"]);
	assert.ok(!normalTools1.includes("bash"), "Normal mode must not inject bash when only powershell exists");

	// 2. 只有 bash：进入 Plan 模式保留 bash，不凭空注入 powershell
	const bashTools = ["read", "bash", "edit", "write", "ask_question"];
	const planTools2 = [...getPlanModeTools(bashTools)];
	assert.deepEqual(planTools2, ["read", "bash", "ask_question"]);
	assert.ok(!planTools2.includes("powershell"), "Plan mode must not inject powershell when only bash exists");

	// 3. 无任何 shell：绝对不添加任何 shell
	const noShellTools = ["read", "edit", "write", "ask_question"];
	const planTools3 = [...getPlanModeTools(noShellTools)];
	assert.deepEqual(planTools3, ["read", "ask_question"]);
	assert.ok(!planTools3.includes("bash"));
	assert.ok(!planTools3.includes("powershell"));

	// 4. 两者都有：两者均保留
	const dualTools = ["read", "bash", "powershell", "edit", "write", "ask_question"];
	const planTools4 = [...getPlanModeTools(dualTools)];
	assert.deepEqual(planTools4, ["read", "bash", "powershell", "ask_question"]);
});

test("isSafePowerShellCommand allows read-only PowerShell commands and safe pipelines", () => {
	const { isSafePowerShellCommand } = loadPlanModeModule();

	// 基础只读
	assert.equal(isSafePowerShellCommand("Get-Content ./a.txt"), true);
	assert.equal(isSafePowerShellCommand("gc ./a.txt"), true);
	assert.equal(isSafePowerShellCommand("cat ./a.txt"), true);
	assert.equal(isSafePowerShellCommand("Get-ChildItem -Recurse"), true);
	assert.equal(isSafePowerShellCommand("gci"), true);
	assert.equal(isSafePowerShellCommand("ls"), true);
	assert.equal(isSafePowerShellCommand("dir"), true);
	assert.equal(isSafePowerShellCommand("Select-String -Pattern 'TODO' ./src"), true);
	assert.equal(isSafePowerShellCommand("Get-Location"), true);
	assert.equal(isSafePowerShellCommand("git status"), true);
	assert.equal(isSafePowerShellCommand("git diff HEAD"), true);

	// 安全管道
	assert.equal(isSafePowerShellCommand("Get-Content a.txt | Select-String 'abc'"), true);
	assert.equal(isSafePowerShellCommand("Get-Content a.txt | Select-String 'abc' | Measure-Object"), true);
	assert.equal(isSafePowerShellCommand("Get-ChildItem | Where-Object { $_.Length -gt 100 } | Select-Object Name"), true);
	assert.equal(isSafePowerShellCommand("Get-Content a.txt | Out-String"), true);
	assert.equal(isSafePowerShellCommand("Get-ChildItem | Format-Table Name, Length"), true);
});

test("isSafePowerShellCommand blocks dangerous commands, redirection and malicious pipelines", () => {
	const { isSafePowerShellCommand } = loadPlanModeModule();

	// 单个写/删命令
	assert.equal(isSafePowerShellCommand("Remove-Item ./a.txt"), false);
	assert.equal(isSafePowerShellCommand("rm ./a.txt"), false);
	assert.equal(isSafePowerShellCommand("del ./a.txt"), false);
	assert.equal(isSafePowerShellCommand("Set-Content ./a.txt 'content'"), false);
	assert.equal(isSafePowerShellCommand("sc ./a.txt 'content'"), false);
	assert.equal(isSafePowerShellCommand("Add-Content ./a.txt 'line'"), false);
	assert.equal(isSafePowerShellCommand("New-Item -ItemType File ./b.txt"), false);
	assert.equal(isSafePowerShellCommand("mkdir ./newdir"), false);
	assert.equal(isSafePowerShellCommand("git push origin main"), false);
	assert.equal(isSafePowerShellCommand("git commit -m 'test'"), false);
	assert.equal(isSafePowerShellCommand("npm install express"), false);

	// 核心：管道危险命令拦截
	assert.equal(isSafePowerShellCommand("Get-Content a.txt | Set-Content b.txt"), false);
	assert.equal(isSafePowerShellCommand("Get-Content a.txt | Out-File b.txt"), false);
	assert.equal(isSafePowerShellCommand("Get-ChildItem | Remove-Item -Force"), false);
	assert.equal(isSafePowerShellCommand("Get-ChildItem | rm -Recurse"), false);
	assert.equal(isSafePowerShellCommand("cat a.txt | Out-File b.txt"), false);
	assert.equal(isSafePowerShellCommand("Get-Content a.txt | % { rm $_ }"), false);

	// 重定向
	assert.equal(isSafePowerShellCommand("Get-Content a.txt > b.txt"), false);
	assert.equal(isSafePowerShellCommand("Get-Content a.txt >> b.txt"), false);

	// 多语句/分号拼接
	assert.equal(isSafePowerShellCommand("Get-Content a.txt; Remove-Item b.txt"), false);
	assert.equal(isSafePowerShellCommand("Get-ChildItem && del a.txt"), false);

	// 未知第三方命令在管道中
	assert.equal(isSafePowerShellCommand("Get-Content a.txt | Invoke-CustomScript"), false);
});

test("plan-mode tool_call blocks dangerous PowerShell and allows safe PowerShell during plan mode", async () => {
	const { default: planModeExtension } = loadPlanModeModule();

	const handlers = new Map();
	const fakePi = {
		on: (event, handler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		appendEntry: () => {},
		getActiveTools: () => ["read", "powershell", "ask_question"],
		setActiveTools: () => {},
	};

	planModeExtension(fakePi);

	const inputHandler = handlers.get("input");
	const toolCallHandler = handlers.get("tool_call");

	const ctx = {
		ui: {
			setWidget: () => {},
			notify: () => {},
		},
	};

	// 进入 plan 模式
	await inputHandler({ text: "__PI_DECK_PLAN_MODE__ analyze project" }, ctx);

	// 危险 powershell 管道调用 -> 阻止
	const blockedResult = await toolCallHandler({
		toolName: "powershell",
		input: { command: "Get-Content a.txt | Set-Content b.txt" },
	});
	assert.ok(blockedResult?.block, "Dangerous PowerShell pipeline must be blocked in plan mode");
	assert.match(blockedResult.reason, /blocked a non-read-only command/);

	// 安全 powershell 调用 -> 放行
	const safeResult = await toolCallHandler({
		toolName: "powershell",
		input: { command: "Get-Content a.txt | Select-String 'abc'" },
	});
	assert.equal(safeResult, undefined, "Safe PowerShell pipeline should be allowed");
});
