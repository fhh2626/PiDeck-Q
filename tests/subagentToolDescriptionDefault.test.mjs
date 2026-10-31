import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * subagent 工具描述的默认解析。
 *
 * 未设置 toolDescriptionMode 时：先读 subagent-tool-description.md（项目配置目录优先，
 * 其次 agent 目录），文件缺失/空/超大/不可读时回落到内置 DEFAULT——不是 full/compact。
 * 显式 full/compact/custom 保持原有语义。
 */

const MODULE = "resources/extensions/pideck-q-subagents/src/extension/tool-description.ts";
const CUSTOM_FILE = "subagent-tool-description.md";

function loadDescriptionModule() {
	return loadTsCommonJs(MODULE, {
		stubs: {
			"../shared/utils.ts": {
				// 用例总是显式传 options.agentDir / options.cwd，不碰真实 agent 目录。
				// 与生产实现保持一致：项目配置目录是 <cwd>/.pi，而不是 <cwd>/.pi/agent。
				getAgentDir: () => {
					throw new Error("test must pass options.agentDir");
				},
				getProjectConfigDir: (cwd) => join(cwd, ".pi"),
			},
		},
	});
}

/** 每个用例独立临时目录，避免读到真实的 ~/.pi/agent。 */
function withSandbox(run) {
	const root = mkdtempSync(join(tmpdir(), "subagent-description-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	try {
		return run({ agentDir, cwd });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const silent = { warn: () => {} };

test("default mode prefers the custom file and appends safety guidance", () => {
	withSandbox(({ agentDir, cwd }) => {
		writeFileSync(join(agentDir, CUSTOM_FILE), "CUSTOM TOOL DESCRIPTION", "utf8");
		const module = loadDescriptionModule();
		const description = module.buildSubagentToolDescription({}, { ...silent, agentDir, cwd });
		assert.match(description, /^CUSTOM TOOL DESCRIPTION/);
		assert.match(description, /SAFETY-CRITICAL SUBAGENT GUIDANCE/);
	});
});

test("default mode falls back to the built-in description without a custom file", () => {
	withSandbox(({ agentDir, cwd }) => {
		const module = loadDescriptionModule();
		const description = module.buildSubagentToolDescription({}, { ...silent, agentDir, cwd });
		assert.equal(description, module.DEFAULT_SUBAGENT_TOOL_DESCRIPTION);
	});
});

test("an oversized custom file falls back to the built-in description", () => {
	withSandbox(({ agentDir, cwd }) => {
		writeFileSync(join(agentDir, CUSTOM_FILE), "x".repeat(50 * 1024 + 1), "utf8");
		const module = loadDescriptionModule();
		const description = module.buildSubagentToolDescription({}, { ...silent, agentDir, cwd });
		assert.equal(description, module.DEFAULT_SUBAGENT_TOOL_DESCRIPTION);
	});
});

test("default mode keeps prompt metadata alongside the custom description", () => {
	withSandbox(({ agentDir, cwd }) => {
		writeFileSync(join(agentDir, CUSTOM_FILE), "CUSTOM TOOL DESCRIPTION", "utf8");
		const module = loadDescriptionModule();
		const metadata = module.buildSubagentToolPromptMetadata({});
		assert.ok(metadata.promptSnippet, "promptSnippet 应保留");
		assert.ok(metadata.promptGuidelines?.length, "promptGuidelines 应保留");
	});
});

test("an empty custom file falls back to the built-in description instead of full", () => {
	withSandbox(({ agentDir, cwd }) => {
		writeFileSync(join(agentDir, CUSTOM_FILE), "   \n", "utf8");
		const module = loadDescriptionModule();
		const description = module.buildSubagentToolDescription({}, { ...silent, agentDir, cwd });
		assert.equal(description, module.DEFAULT_SUBAGENT_TOOL_DESCRIPTION);
	});
});

test("explicit compact and full modes ignore the custom file", () => {
	withSandbox(({ agentDir, cwd }) => {
		writeFileSync(join(agentDir, CUSTOM_FILE), "CUSTOM TOOL DESCRIPTION", "utf8");
		const module = loadDescriptionModule();
		assert.equal(
			module.buildSubagentToolDescription({ toolDescriptionMode: "compact" }, { ...silent, agentDir, cwd }),
			module.COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		);
		assert.equal(
			module.buildSubagentToolDescription({ toolDescriptionMode: "full" }, { ...silent, agentDir, cwd }),
			module.FULL_SUBAGENT_TOOL_DESCRIPTION,
		);
	});
});

test("explicit custom mode still falls back to full when the file is missing", () => {
	withSandbox(({ agentDir, cwd }) => {
		const module = loadDescriptionModule();
		assert.equal(
			module.buildSubagentToolDescription({ toolDescriptionMode: "custom" }, { ...silent, agentDir, cwd }),
			module.FULL_SUBAGENT_TOOL_DESCRIPTION,
		);
	});
});

test("project config dir wins over the agent dir", () => {
	withSandbox(({ agentDir, cwd }) => {
		writeFileSync(join(agentDir, CUSTOM_FILE), "AGENT DIR DESCRIPTION", "utf8");
		writeFileSync(join(cwd, ".pi", CUSTOM_FILE), "PROJECT DIR DESCRIPTION", "utf8");
		const module = loadDescriptionModule();
		const description = module.buildSubagentToolDescription({}, { ...silent, agentDir, cwd });
		assert.match(description, /^PROJECT DIR DESCRIPTION/);
	});
});

test("descriptions do not reference removed agent roles or request modes", () => {
	const module = loadDescriptionModule();
	// 内置 agent 现在只有 readonly/writable；one-shot 请求模式也已不存在。
	// 这三份文案都会直接进入模型提示词，因此防止旧名称回退。
	for (const description of [
		module.SUBAGENT_SAFETY_GUIDANCE,
		module.COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		module.FULL_SUBAGENT_TOOL_DESCRIPTION,
	]) {
		assert.doesNotMatch(description, /Oracle\/advisor/);
		assert.doesNotMatch(description, /request one-shot/);
	}
});

test("built-in descriptions only use existing agent names", () => {
	const module = loadDescriptionModule();
	const builtinAgents = new Set(["readonly", "writable"]);
	// 捕获示例里的 agent:'<name>'，避免 worker/oracle/advisor 之类的旧角色名回退。
	for (const description of [
		module.DEFAULT_SUBAGENT_TOOL_DESCRIPTION,
		module.FULL_SUBAGENT_TOOL_DESCRIPTION,
		module.COMPACT_SUBAGENT_TOOL_DESCRIPTION,
	]) {
		for (const match of description.matchAll(/agent\s*:\s*["']([a-z0-9_-]+)["']/gi)) {
			assert.ok(builtinAgents.has(match[1]), `unexpected agent name in prompt: ${match[1]}`);
		}
	}
});

test("falls back to the agent dir when the project file is empty", () => {
	withSandbox(({ agentDir, cwd }) => {
		writeFileSync(join(cwd, ".pi", CUSTOM_FILE), "   \n", "utf8");
		writeFileSync(join(agentDir, CUSTOM_FILE), "AGENT DIR DESCRIPTION", "utf8");
		const module = loadDescriptionModule();
		const warnings = [];
		const description = module.buildSubagentToolDescription({}, {
			agentDir,
			cwd,
			warn: (message) => warnings.push(message),
		});
		assert.match(description, /^AGENT DIR DESCRIPTION/);
		// 空的项目文件告警一次，然后继续采用 agent 目录里的有效文件。
		assert.equal(warnings.length, 1);
	});
});

test("a custom file that already contains safety guidance is not duplicated", () => {
	withSandbox(({ agentDir, cwd }) => {
		const module = loadDescriptionModule();
		writeFileSync(
			join(agentDir, CUSTOM_FILE),
			`CUSTOM DESCRIPTION\n\n${module.SUBAGENT_SAFETY_GUIDANCE}\n`,
			"utf8",
		);
		const description = module.buildSubagentToolDescription({}, { ...silent, agentDir, cwd });
		assert.match(description, /^CUSTOM DESCRIPTION/);
		assert.equal((description.match(/SAFETY-CRITICAL SUBAGENT GUIDANCE/g) ?? []).length, 1);
	});
});
