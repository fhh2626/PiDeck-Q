import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

async function loadSecurityGateExtension(envOverrides = {}) {
	const source = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});

	const handlers = new Map();
	const fakePi = {
		on: (event, handler) => {
			handlers.set(event, handler);
		},
	};

	const originalEnv = { ...process.env };
	Object.assign(process.env, envOverrides);

	const sandbox = {
		exports: {},
		require,
		console,
		process,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "pi-deck-security-gate.ts" });
	await sandbox.exports.default(fakePi);

	return {
		toolCall: async (event, ctx) => {
			const fn = handlers.get("tool_call");
			if (!fn) throw new Error("tool_call handler not registered");
			return await fn(event, ctx);
		},
		cleanup: () => {
			process.env = originalEnv;
		},
	};
}

test("Security Gate: write/edit extracts path and enforces workspace boundaries", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-sec-gate-"));
	const configPath = join(tempDir, "policy.json");
	const workspaceDir = join(tempDir, "workspace");
	const outsideDir = join(tempDir, "outside");

	const snapshot = {
		schemaVersion: 1,
		enabled: true,
		defaultLevelId: "strict",
		levels: [
			{
				id: "strict",
				name: "严格",
				description: "严格模式",
				toolActions: {
					read: "allow",
					write: "allow",
					edit: "allow",
					bash: "allow",
					powershell: "allow",
				},
				denyBashPatterns: [],
				denyPowerShellPatterns: [],
				pathPolicy: "workspace",
				customAllowDirs: [],
				denyDirs: [],
				protectSensitivePaths: true,
				defaultAction: "deny",
			},
		],
		sessionLevels: {},
	};

	writeFileSync(configPath, JSON.stringify(snapshot), "utf8");

	const { toolCall, cleanup } = await loadSecurityGateExtension({
		PIDECK_SECURITY_CONFIG: configPath,
		PIDECK_SESSION_ID: "session-1",
	});

	try {
		const ctx = { cwd: workspaceDir, hasUI: false, ui: {} };

		// write + path in workspace -> allowed (returns undefined)
		const res1 = await toolCall({ toolName: "write", input: { path: join(workspaceDir, "a.txt"), content: "ok" } }, ctx);
		assert.equal(res1, undefined, "write in workspace should be allowed");

		// write + path outside workspace -> denied (blocked: true)
		const res2 = await toolCall({ toolName: "write", input: { path: join(outsideDir, "a.txt"), content: "no" } }, ctx);
		assert.ok(res2?.block, "write outside workspace must be denied");
		assert.match(res2.reason, /被拒绝/);

		// edit + path outside workspace -> denied
		const res3 = await toolCall({ toolName: "edit", input: { path: join(outsideDir, "a.txt"), edits: [] } }, ctx);
		assert.ok(res3?.block, "edit outside workspace must be denied");

		// write + path = .../.env -> protectSensitivePaths=true -> denied
		const res4 = await toolCall({ toolName: "write", input: { path: join(workspaceDir, ".env"), content: "SECRET=1" } }, ctx);
		assert.ok(res4?.block, "write .env must be denied under protectSensitivePaths");

		// edit + path = .../.git/config -> protectSensitivePaths=true -> denied
		const res5 = await toolCall({ toolName: "edit", input: { path: join(workspaceDir, ".git", "config"), edits: [] } }, ctx);
		assert.ok(res5?.block, "edit .git/config must be denied under protectSensitivePaths");

		// write/edit legacy filePath compatibility
		const resLegacyAllow = await toolCall({ toolName: "write", input: { filePath: join(workspaceDir, "b.txt"), content: "ok" } }, ctx);
		assert.equal(resLegacyAllow, undefined, "write with legacy filePath inside workspace should be allowed");

		const resLegacyDeny = await toolCall({ toolName: "edit", input: { filePath: join(outsideDir, "b.txt"), edits: [] } }, ctx);
		assert.ok(resLegacyDeny?.block, "edit with legacy filePath outside workspace must be denied");
	} finally {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Security Gate: powershell is managed, respects dangerous patterns and toolActions.powershell", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-sec-gate-pwsh-"));
	const configPath = join(tempDir, "policy.json");

	const snapshot = {
		schemaVersion: 1,
		enabled: true,
		defaultLevelId: "standard",
		levels: [
			{
				id: "standard",
				name: "标准",
				description: "标准模式",
				// powershell 设置为 deny (危险命令默认行为由 shellAction 决定，defaultAction 为 deny 时危险命令直接 deny)
				toolActions: {
					bash: "allow", // bash 显式 allow，验证 powershell 独立读取自身动作
					powershell: "ask",
				},
				denyBashPatterns: ["\\brm\\b"],
				denyPowerShellPatterns: [
					"\\b(Remove-Item|rm|del)\\b",
					"\\b(Set-Content|Add-Content|New-Item)\\b",
					"\\bgit\\s+push\\b",
				],
				pathPolicy: "unrestricted",
				customAllowDirs: [],
				denyDirs: [],
				protectSensitivePaths: false,
				defaultAction: "deny",
			},
		],
		sessionLevels: {},
	};

	writeFileSync(configPath, JSON.stringify(snapshot), "utf8");

	const { toolCall, cleanup } = await loadSecurityGateExtension({
		PIDECK_SECURITY_CONFIG: configPath,
		PIDECK_SESSION_ID: "session-2",
	});

	try {
		const ctx = { cwd: tempDir, hasUI: false, ui: {} };

		// 1. powershell 不再被 MANAGED_TOOLS 跳过：非安全命令触发拦截（无 UI 模式下 ask 也会拒绝）
		const pwshDeny1 = await toolCall({ toolName: "powershell", input: { command: "Remove-Item -Path ./foo" } }, ctx);
		assert.ok(pwshDeny1?.block, "Remove-Item must trigger dangerous rule");

		const pwshDeny2 = await toolCall({ toolName: "powershell", input: { command: "Set-Content -Path ./a.txt -Value 'hi'" } }, ctx);
		assert.ok(pwshDeny2?.block, "Set-Content must trigger dangerous rule");

		const pwshDeny3 = await toolCall({ toolName: "powershell", input: { command: "New-Item -ItemType File ./b.txt" } }, ctx);
		assert.ok(pwshDeny3?.block, "New-Item must trigger dangerous rule");

		const pwshDeny4 = await toolCall({ toolName: "powershell", input: { command: "git push origin main" } }, ctx);
		assert.ok(pwshDeny4?.block, "git push must trigger dangerous rule");

		// 2. 安全命令不命中危险规则；由于 toolActions.powershell 为 'ask'，但安全命令取 toolActions.powershell
		// 接下来改动 snapshot 让 toolActions.powershell='allow'，再测安全命令直接放行
		snapshot.levels[0].toolActions.powershell = "allow";
		snapshot.levels[0].defaultAction = "deny"; // defaultAction 为 deny
		writeFileSync(configPath, JSON.stringify(snapshot), "utf8");

		// 等待/触发重新加载（修改 mtime 规避 throttle）
		const { toolCall: toolCall2 } = await loadSecurityGateExtension({
			PIDECK_SECURITY_CONFIG: configPath,
			PIDECK_SESSION_ID: "session-2",
		});

		// toolActions.powershell = 'allow' 时，危险命令：因为 toolActions.powershell === 'allow'，按规则显式放行
		// 现在测试：toolActions.bash = 'allow'，toolActions.powershell 未定义（回退 defaultAction='deny'）
		snapshot.levels[0].toolActions = { bash: "allow" };
		writeFileSync(configPath, JSON.stringify(snapshot), "utf8");

		const { toolCall: toolCall3 } = await loadSecurityGateExtension({
			PIDECK_SECURITY_CONFIG: configPath,
			PIDECK_SESSION_ID: "session-2",
		});

		// bash 应该允许（toolActions.bash === 'allow'）
		const bashRes = await toolCall3({ toolName: "bash", input: { command: "ls -la" } }, ctx);
		assert.equal(bashRes, undefined, "bash should be allowed per toolActions.bash");

		// powershell 未在 toolActions 设置，回退 defaultAction='deny' -> 即使普通命令也会被 deny，证明它没有错误复用 toolActions.bash！
		const pwshRes = await toolCall3({ toolName: "powershell", input: { command: "Get-Content a.txt" } }, ctx);
		assert.ok(pwshRes?.block, "powershell must not reuse toolActions.bash='allow'");

		// 现在给 powershell 设置 toolActions.powershell='allow'，验证安全命令放行，而危险命令依然触发处理
		snapshot.levels[0].toolActions = { powershell: "allow" };
		snapshot.levels[0].defaultAction = "deny";
		writeFileSync(configPath, JSON.stringify(snapshot), "utf8");
		const { toolCall: toolCall4 } = await loadSecurityGateExtension({
			PIDECK_SECURITY_CONFIG: configPath,
			PIDECK_SESSION_ID: "session-2",
		});

		const safe1 = await toolCall4({ toolName: "powershell", input: { command: "Get-Content a.txt" } }, ctx);
		assert.equal(safe1, undefined, "Get-Content should be allowed");

		const safe2 = await toolCall4({ toolName: "powershell", input: { command: "Get-ChildItem -Recurse" } }, ctx);
		assert.equal(safe2, undefined, "Get-ChildItem should be allowed");

		const safe3 = await toolCall4({ toolName: "powershell", input: { command: "Select-String foo bar.txt" } }, ctx);
		assert.equal(safe3, undefined, "Select-String should be allowed");

		const safe4 = await toolCall4({ toolName: "powershell", input: { command: "git status" } }, ctx);
		assert.equal(safe4, undefined, "git status should be allowed");

		const safe5 = await toolCall4({ toolName: "powershell", input: { command: "git diff" } }, ctx);
		assert.equal(safe5, undefined, "git diff should be allowed");
	} finally {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
