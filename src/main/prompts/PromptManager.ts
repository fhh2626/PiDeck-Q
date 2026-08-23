import type { TrashPath } from "../fs/trash";
import type {
	CreatePiPromptTemplateInput,
	PiPromptTemplateListResult,
	PiPromptTemplateSummary,
} from "../../shared/types";
import type { WslEnvironment } from "../wsl/WslPaths";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export type PromptPlatformOps = {
	openPath?: (path: string) => Promise<{ ok: boolean; error?: string }>;
	trashPath?: TrashPath;
};

export const PROMPT_ALREADY_EXISTS_CODE = "PROMPT_ALREADY_EXISTS";
export class PromptAlreadyExistsError extends Error {
	readonly code = PROMPT_ALREADY_EXISTS_CODE;

	constructor(message: string) {
		super(message);
		this.name = "PromptAlreadyExistsError";
	}
}

export function isPromptAlreadyExistsError(error: unknown): boolean {
	if (error instanceof PromptAlreadyExistsError) return true;
	if (!error || typeof error !== "object") return false;
	return Reflect.get(error, "code") === PROMPT_ALREADY_EXISTS_CODE;
}

type PromptSettingsSlice = {
	hiddenBuiltinPromptNames?: string[];
};

type PromptCopy = (
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
) => string;

function makeBuiltinContent(name: string, body: string): string {
	return `---\ndescription: ${name}\n---\n\n${body}`;
}

/** 推荐模板：用户刚接触 prompt templates 时可快速上手的实用模板。
 * 标记 userCreated: false，在 UI 中显示为只读条目。 */
const BUILTIN_TEMPLATES: PiPromptTemplateSummary[] = [
	{
		name: "review",
		path: "builtin://review",
		description: "Review staged git changes for bugs, security issues, and logic errors",
		content: makeBuiltinContent(
			"Review staged git changes",
			"Review the staged changes (\\`git diff --cached\\`). Focus on:\n- Bugs and logic errors\n- Security issues\n- Error handling gaps\n- Edge cases and boundary conditions",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "test",
		path: "builtin://test",
		description: "Write tests for a function or component covering edge cases",
		content: makeBuiltinContent(
			"Write tests for a function or component",
			"Write comprehensive tests. Cover:\n- Happy path\n- Edge cases and boundary conditions\n- Error handling\n- Type correctness",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "fix",
		path: "builtin://fix",
		description: "Debug and fix issues with root cause analysis",
		content: makeBuiltinContent(
			"Debug and fix issues with root cause analysis",
			"Debug and fix the following issue. Before making any changes:\n1. Analyze the root cause\n2. List affected files\n3. Propose the fix\n4. After confirming, apply the fix",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "refactor",
		path: "builtin://refactor",
		description: "Refactor code for better readability and maintainability",
		content: makeBuiltinContent(
			"Refactor code",
			"Refactor. Follow these principles:\n- Keep the same external behavior\n- Improve readability and naming\n- Reduce duplication\n- Add type annotations where they improve clarity\n- Maintain backward compatibility",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "doc",
		path: "builtin://doc",
		description: "Add or improve documentation and comments",
		content: makeBuiltinContent(
			"Add or improve documentation",
			"Add or improve documentation. Include:\n- A brief overview of what it does\n- Parameters and return values\n- Usage examples where helpful\n- Edge cases and assumptions",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "explain",
		path: "builtin://explain",
		description: "Explain code or architecture in simple terms",
		content: makeBuiltinContent(
			"Explain code or architecture",
			"Explain in simple terms. Cover:\n- What it does at a high level\n- Key design decisions\n- How it fits into the broader architecture\n- Potential improvements or concerns",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "pi-system",
		path: "builtin://pi-system",
		description: "View pi's default system prompt (identity, tools, guidelines)",
		content: makeBuiltinContent(
			"Pi system prompt",
			"这是 pi 的默认系统提示词——核心身份描述、可用工具列表、行为准则和文档路径，定义了 AI agent 的行为基础。\n\n---\n\nYou are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n- read: Read file contents\n- bash: Execute bash commands (ls, grep, find, etc.)\n- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call\n- write: Create or overwrite files\n- ask_question: Ask the user a question (or a batch of questions) and wait for responses\n- todo: Manage a todo list (add / toggle / clear)\n- web_search: Use for web research questions with a focused {query:\"...\"}\n- fetch_content: Use to extract readable content from URL(s), YouTube, GitHub repos, or local videos\n- mcp: MCP gateway - connect to MCP servers and call their tools\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n- Use bash for file operations like ls, rg, find\n- Use read to examine files instead of cat or sed.\n- Use edit for precise changes\n- Keep edits[].oldText as small as possible while still being unique\n- Be concise in your responses\n- Show file paths clearly when working with files\n\nCurrent date: YYYY-MM-DD\nCurrent working directory: /path/to/project",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "commit",
		path: "builtin://commit",
		description: "Generate a conventional commit message from staged changes",
		content: makeBuiltinContent(
			"Generate a conventional commit message",
			"Generate a conventional commit message from the staged changes (\\`git diff --cached\\`).\nFormat: \\`type(scope): description\\`\n\nTypes: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "skill-discipline",
		path: "builtin://skill-discipline",
		description: "Skills execution discipline: rules for when and how to trigger agent skills",
		content: `---
description: Skills execution discipline: rules for when and how to trigger agent skills
---

# ========================================================================
# Skill Execution Discipline
# ========================================================================

This section defines when and how skills from available_skills should be triggered.
It helps suppress the tendency to "think first, then call a skill", ensuring skills
are invoked promptly when appropriate.

## Core Principle

Available skills are registered in this system. You should and must call them
when appropriate. If unsure whether a skill is needed, follow the rule:
**"Call before thinking"**—the cost of calling a skill is far lower than the risk of missing one.
**Skills are not a substitute for thinking; they are the starting point for thinking.**

## Execution Rules

1. **Trigger and Execute**: When user input matches any description or TRIGGERS
   keyword/scenario in a skill, call it immediately. Do NOT:
   - "Let me reason first, then decide"
   - "This is simple enough, I'll handle it"
   - "I'll give a preliminary answer first"

2. **No Bypassing**: If you catch yourself "answering yourself" instead of
   "calling a skill then answering", pause and re-evaluate.

3. **Priority Order** (conflict resolution):
   P0 — Meta skills (always first)
   P1 — Process discipline (testing, debugging, verification)
   P2 — Problem solving (plans, diagnosis, conflict resolution)
   P3 — Functional tools (browser, file organizer, vault)
   P4 — Design/review (codebase design, domain modeling, code review)
   P5 — Other skills by relevance

4. **Fallback**: When multiple skills might match and you're unsure which to pick,
   call the meta skill or output the candidate list for the user to choose.

## Thinking Inhibition

> Do NOT perform prolonged independent reasoning before calling a skill.
> The right flow: user input → check TRIGGERS → call skill → follow skill instructions

## Recursion Guard
> Each skill is called at most once per conversation turn unless context changes significantly.
> Avoid A calls B, B references A in an infinite loop.`,
		userCreated: false,
		scope: "global",
	},
];

/**
 * 管理 pi 全局 Prompt Templates 目录 (~/.pi/agent/prompts/)。
 * 
 * Prompt Templates 是 markdown 文件，用户可在 pi 中输入 /<name> 快速展开。
 * frontmatter 支持 description、argument-hint 等元数据。
 */
export class PromptManager {
	private promptsDir: string;
	/**
	 * 构造时注入的本地基准 home。
	 * configureWsl(null) 恢复的是该值，而不是重新读取 os.homedir()，
	 * 这样测试/CLI host 注入的隔离 HOME 不会被启动任务覆盖。
	 */
	private readonly localHome: string;

	constructor(
		home?: string,
		private readonly translate: PromptCopy = () => "Prompt operation failed.",
		private readonly getSettings: () => PromptSettingsSlice = () => ({ hiddenBuiltinPromptNames: [] }),
		private readonly patchSettings: (patch: PromptSettingsSlice) => Promise<unknown> = async () => undefined,
		private readonly platformOps?: PromptPlatformOps,
	) {
		this.localHome = home ?? homedir();
		this.promptsDir = join(this.localHome, ".pi", "agent", "prompts");
	}

	/** 将 prompt 目录切换到统一解析出的 WSL HOME；null 恢复构造时注入的本地 home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.promptsDir = join(environment?.windowsHome ?? this.localHome, ".pi", "agent", "prompts");
	}

	getDir(): string {
		return this.promptsDir;
	}

	async list(): Promise<PiPromptTemplateListResult> {
		await mkdir(this.promptsDir, { recursive: true });
		const entries = await readdir(this.promptsDir).catch(() => []);
		const templates: PiPromptTemplateSummary[] = [];

		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			if (entry.endsWith(".d.md")) continue;
			const fullPath = join(this.promptsDir, entry);
			const raw = await readFile(fullPath, "utf8").catch(() => "");
			if (!raw) continue;

			const name = basename(entry, ".md");
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";

			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^["']|["']$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "global",
			});
		}

		// 合并内置推荐模板（同名不覆盖用户已有模板；已删除的内置项不再补回）
		const userNames = new Set(templates.map((t) => t.name));
		const hiddenNames = new Set(this.getHiddenBuiltinNames());
		for (const builtin of BUILTIN_TEMPLATES) {
			if (!userNames.has(builtin.name) && !hiddenNames.has(builtin.name)) {
				templates.push(builtin);
			}
		}

		// 按 name 排序
		templates.sort((a, b) => a.name.localeCompare(b.name));

		return {
			templates,
			globalDir: this.promptsDir,
			hasHiddenBuiltins: this.hasHiddenBuiltins(),
		};
	}

	async create(input: CreatePiPromptTemplateInput): Promise<PiPromptTemplateSummary> {
		const name = this.normalizeName(input.name);
		if (!name) throw new Error(this.translate("mainPrompt.nameRequiredDetailed"));
		const description = input.description.trim();
		if (!description) throw new Error(this.translate("mainPrompt.descriptionRequired"));

		const filePath = join(this.promptsDir, `${name}.md`);
		const alreadyExistsMessage = this.translate("mainPrompt.alreadyExists", { name });
		if (existsSync(filePath)) throw new PromptAlreadyExistsError(alreadyExistsMessage);

		// 内容仅含 frontmatter 中的 description，正文由用户后续在编辑器中编写，不与 skill 重复展示描述
		const content = `---\ndescription: ${description.replace(/\n/g, " ")}\n---\n`;
		try {
			// The existence check is only an early UX path; wx closes the race between
			// two concurrent imports so one cannot silently overwrite the other.
			await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
		} catch (error: unknown) {
			if (error && typeof error === "object" && Reflect.get(error, "code") === "EEXIST") {
				throw new PromptAlreadyExistsError(alreadyExistsMessage);
			}
			throw error;
		}

		return {
			name,
			path: filePath,
			description,
			content,
			userCreated: true,
		};
	}

	async delete(filePath: string): Promise<void> {
		// 内置模板没有磁盘文件：记下删除标记，后续 list 不再补回。
		if (filePath.startsWith("builtin://")) {
			await this.hideBuiltin(filePath.slice("builtin://".length));
			return;
		}
		if (!filePath.startsWith(this.promptsDir)) {
			throw new Error(this.translate("mainPrompt.globalDeleteOnly"));
		}
		if (!existsSync(filePath)) {
			throw new Error(this.translate("mainPrompt.fileNotFound"));
		}
		if (!this.platformOps?.trashPath) {
			throw new Error("Trash service unavailable");
		}
		// 提示词模板是用户内容：删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝硬删。
		await this.platformOps.trashPath(filePath, { source: "prompts:delete" });
	}

	/** 是否还有被用户删除、可被「找回默认模板」恢复的内置项。 */
	hasHiddenBuiltins(): boolean {
		return this.getHiddenBuiltinNames().length > 0;
	}

	/**
	 * 清空内置模板删除标记，使全部默认模板重新出现在列表和斜杠补全中。
	 * 用户已创建的同名文件仍优先，不会被内置内容覆盖。
	 */
	async restoreHiddenBuiltins(): Promise<void> {
		if (!this.hasHiddenBuiltins()) return;
		await this.patchSettings({ hiddenBuiltinPromptNames: [] });
	}

	private getHiddenBuiltinNames(): string[] {
		const raw = this.getSettings().hiddenBuiltinPromptNames ?? [];
		const known = new Set(BUILTIN_TEMPLATES.map((template) => template.name));
		const names: string[] = [];
		const seen = new Set<string>();
		for (const value of raw) {
			if (typeof value !== "string") continue;
			const name = value.trim();
			if (!name || !known.has(name) || seen.has(name)) continue;
			seen.add(name);
			names.push(name);
		}
		return names;
	}

	private async hideBuiltin(rawName: string): Promise<void> {
		const name = rawName.trim();
		const known = BUILTIN_TEMPLATES.some((template) => template.name === name);
		if (!known) {
			throw new Error(this.translate("mainPrompt.fileNotFound"));
		}
		const current = this.getHiddenBuiltinNames();
		if (current.includes(name)) return;
		await this.patchSettings({ hiddenBuiltinPromptNames: [...current, name] });
	}

	/** 扫描项目 .pi/prompts/ 目录下的模板 */
	async listByProject(projectPath: string): Promise<PiPromptTemplateListResult> {
		const projectPromptsDir = join(projectPath, ".pi", "prompts");
		const entries = await readdir(projectPromptsDir).catch(() => []);
		const templates: PiPromptTemplateSummary[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			if (entry.endsWith(".d.md")) continue;
			const fullPath = join(projectPromptsDir, entry);
			const raw = await readFile(fullPath, "utf8").catch(() => "");
			if (!raw) continue;
			const name = basename(entry, ".md");
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";

			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^["']|["']$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "project",
			});
		}
		templates.sort((a, b) => a.name.localeCompare(b.name));
		// 项目级模板没有内置推荐项，找回默认模板只作用于全局列表。
		return { templates, globalDir: projectPromptsDir, hasHiddenBuiltins: false };
	}

	/** 在项目 .pi/prompts/ 下创建模板 */
	async createInProject(
		projectPath: string,
		input: CreatePiPromptTemplateInput,
	): Promise<PiPromptTemplateSummary> {
		const projectPromptsDir = join(projectPath, ".pi", "prompts");
		await mkdir(projectPromptsDir, { recursive: true });
		const name = this.normalizeName(input.name);
		if (!name) throw new Error(this.translate("mainPrompt.nameRequiredDetailed"));
		const description = input.description.trim();
		if (!description) throw new Error(this.translate("mainPrompt.descriptionRequired"));
		const filePath = join(projectPromptsDir, `${name}.md`);
		if (existsSync(filePath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name }));
		// 内容仅含 frontmatter 中的 description，正文由用户后续编辑
		const content = `---\ndescription: ${description.replace(/\n/g, " ")}\n---\n`;
		await writeFile(filePath, content, "utf8");
		return {
			name,
			path: filePath,
			description,
			content,
			userCreated: true,
			scope: "project",
		};
	}

	/** 从项目 .pi/prompts/ 删除模板 */
	async deleteFromProject(projectPath: string, fileName: string): Promise<void> {
		const filePath = join(projectPath, ".pi", "prompts", fileName);
		if (!existsSync(filePath)) throw new Error(this.translate("mainPrompt.fileNotFound"));
		if (!this.platformOps?.trashPath) {
			throw new Error("Trash service unavailable");
		}
		// 项目内模板同样走回收站，避免误删后无法恢复。
		await this.platformOps.trashPath(filePath, { source: "prompts:delete-project" });
	}

	async openFolder(): Promise<void> {
		await mkdir(this.promptsDir, { recursive: true });
		if (this.platformOps?.openPath) {
			await this.platformOps.openPath(this.promptsDir);
		}
	}

	/**
	 * 读取模板原始内容（供编辑器使用）
	 */
	async readContent(filePath: string): Promise<string> {
		return readFile(filePath, "utf8");
	}

	/**
	 * 保存模板内容
	 */
	async writeContent(filePath: string, content: string): Promise<void> {
		if (!filePath.startsWith(this.promptsDir)) {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
		await writeFile(filePath, content, "utf8");
	}

	private parseFrontmatter(raw: string): Record<string, string> {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const result: Record<string, string> = {};
		if (!match) return result;
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			let value = line.slice(index + 1).trim();
			value = value.replace(/^['\"]|['\"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
	}

	/** 重命名全局模板：将 <oldName>.md 重命名为 <newName>.md */
	async rename(oldName: string, newName: string): Promise<PiPromptTemplateSummary> {
		const normalizedOld = this.normalizeName(oldName);
		const normalizedNew = this.normalizeName(newName);
		if (!normalizedOld || !normalizedNew) throw new Error(this.translate("mainPrompt.nameRequired"));
		if (normalizedOld === normalizedNew) throw new Error(this.translate("mainPrompt.sameName"));

		const oldPath = join(this.promptsDir, `${normalizedOld}.md`);
		const newPath = join(this.promptsDir, `${normalizedNew}.md`);
		if (!existsSync(oldPath)) throw new Error(this.translate("mainPrompt.notFound", { name: oldName }));
		if (existsSync(newPath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name: normalizedNew }));

		await rename(oldPath, newPath);
		// 读取新文件内容返回摘要
		const raw = await readFile(newPath, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		const description = frontmatter.description ?? "";
		return {
			name: normalizedNew,
			path: newPath,
			description: description.replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "global",
		};
	}

	/** 重命名项目级模板 */
	async renameInProject(projectPath: string, oldName: string, newName: string): Promise<PiPromptTemplateSummary> {
		const projectPromptsDir = join(projectPath, ".pi", "prompts");
		const normalizedOld = this.normalizeName(oldName);
		const normalizedNew = this.normalizeName(newName);
		if (!normalizedOld || !normalizedNew) throw new Error(this.translate("mainPrompt.nameRequired"));
		if (normalizedOld === normalizedNew) throw new Error(this.translate("mainPrompt.sameName"));

		const oldPath = join(projectPromptsDir, `${normalizedOld}.md`);
		const newPath = join(projectPromptsDir, `${normalizedNew}.md`);
		if (!existsSync(oldPath)) throw new Error(this.translate("mainPrompt.notFound", { name: oldName }));
		if (existsSync(newPath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name: normalizedNew }));

		await rename(oldPath, newPath);
		const raw = await readFile(newPath, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		const description = frontmatter.description ?? "";
		return {
			name: normalizedNew,
			path: newPath,
			description: description.replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "project",
		};
	}

	/** 规范化模板名称：保留 Unicode 字母（含中文等非拉丁文字）、数字和连字符，其余替换为连字符 */
	private normalizeName(value: string): string {
		return value
			.trim()
			// 替换非（Unicode 字母/数字/连字符）的字符为连字符
			.replace(/[^\p{L}\p{N}-]/gu, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.toLowerCase();
	}
}
