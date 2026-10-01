import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * A2：提示词/技能重命名必须走 renameWithoutOverwrite，而不是
 * existsSync 预检 + rename 两步（两步之间目标被创建就会被覆盖）。
 *
 * 这里把 renameWithoutOverwrite 换成「先记录调用、再抛冲突」的替身：
 * - 旧实现根本不引用该模块 → calls 为空，断言失败（红）。
 * - 新实现会调用它，并把冲突码转换成已有的 alreadyExists 文案（绿）。
 */
function loadWithConflictRename(modulePath) {
	const real = loadTsCommonJs("src/main/fs/renameWithoutOverwrite.ts");
	const calls = [];
	const renameWithoutOverwrite = async (source, target) => {
		calls.push({ source, target });
		throw new real.RenameTargetExistsError(target);
	};
	const loaded = loadTsCommonJs(modulePath, {
		stubs: {
			"../fs/renameWithoutOverwrite": { ...real, renameWithoutOverwrite },
		},
	});
	return { loaded, calls };
}

test("PromptManager.rename delegates to the no-clobber rename and reports the conflict", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-prompt-rename-race-"));
	try {
		const { loaded, calls } = loadWithConflictRename("src/main/prompts/PromptManager.ts");
		const seen = [];
		const manager = new loaded.PromptManager(
			join(root, "home"),
			(key) => {
				seen.push(key);
				return key;
			},
			() => ({ hiddenBuiltinPromptNames: [] }),
			async () => undefined,
			{ trashPath: async () => undefined },
			() => [],
		);
		await mkdir(manager.getDir(), { recursive: true });
		await writeFile(join(manager.getDir(), "alpha.md"), "---\ndescription: Alpha\n---\nA");

		await assert.rejects(
			() => manager.rename("alpha", "beta"),
			(error) => String(error?.message ?? error).includes("mainPrompt.alreadyExists"),
		);
		assert.equal(calls.length, 1, "重命名必须经由 renameWithoutOverwrite");
		assert.equal(calls[0].target, join(manager.getDir(), "beta.md"));
		assert.deepEqual(seen.filter((key) => key.startsWith("mainPrompt")), ["mainPrompt.alreadyExists"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("PromptManager.renameInProject delegates to the no-clobber rename", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-prompt-rename-project-race-"));
	const project = join(root, "project");
	try {
		const { loaded, calls } = loadWithConflictRename("src/main/prompts/PromptManager.ts");
		const manager = new loaded.PromptManager(
			join(root, "home"),
			(key) => key,
			() => ({ hiddenBuiltinPromptNames: [] }),
			async () => undefined,
			{ trashPath: async () => undefined },
			() => [project],
		);
		const projectPrompts = join(project, ".pi", "prompts");
		await mkdir(projectPrompts, { recursive: true });
		await writeFile(join(projectPrompts, "alpha.md"), "---\ndescription: Alpha\n---\nA");

		await assert.rejects(
			() => manager.renameInProject(project, "alpha", "beta"),
			(error) => String(error?.message ?? error).includes("mainPrompt.alreadyExists"),
		);
		assert.equal(calls.length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("SkillManager.rename delegates to the no-clobber rename and keeps the skill intact", async () => {
	const home = await mkdtemp(join(tmpdir(), "pideck-skill-rename-race-"));
	try {
		const { loaded, calls } = loadWithConflictRename("src/main/skills/SkillManager.ts");
		const manager = new loaded.SkillManager(home, (key) => key);
		const skillDir = join(home, ".pi", "agent", "skills", "old-skill");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, "SKILL.md"),
			"---\nname: old-skill\ndescription: Old\n---\n\n# old-skill\n",
		);

		await assert.rejects(() => manager.rename(join(skillDir, "SKILL.md"), "new-skill"));
		assert.equal(calls.length, 1, "重命名必须经由 renameWithoutOverwrite");
		// 冲突（或延迟冲突）时技能目录必须原样保留
		assert.match(await readFile(join(skillDir, "SKILL.md"), "utf8"), /name: old-skill/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
