import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

class SymlinkUnavailableError extends Error {}

function loadSkillManagerModule() {
	const source = readFileSync("src/main/skills/SkillManager.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		process,
		require: (id) => {
			if (id === "electron") return { shell: { openPath: async () => "" } };
			// 删除统一入口：测试环境无回收站，noop stub（本测试不触达删除路径）
			if (id === "../fs/trash") return { trashPath: async () => {} };
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			return require(id);
		},
	};
	sandbox.global = sandbox;
	vm.runInNewContext(outputText, sandbox, {
		filename: "SkillManager.ts",
	});
	return sandbox.exports;
}

async function createSkillFile(path, name, description = `${name} description`) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
		"utf8",
	);
}

async function createSkillRoot(home) {
	const globalSkills = join(home, ".pi", "agent", "skills");
	await mkdir(globalSkills, { recursive: true });
	return globalSkills;
}

async function createDirectoryLink(target, linkPath) {
	try {
		await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) {
			throw new SymlinkUnavailableError(error.message);
		}
		throw error;
	}
}

async function createFileLink(target, linkPath) {
	try {
		await symlink(target, linkPath, "file");
	} catch (error) {
		if (["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) {
			throw new SymlinkUnavailableError(error.message);
		}
		throw error;
	}
}

async function withTemporaryHome(run) {
	const home = await mkdtemp(join(tmpdir(), "pideck-skill-manager-"));
	try {
		await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function skipUnavailable(t, error) {
	if (error instanceof SymlinkUnavailableError) {
		t.skip(`软连接不可用：${error.message}`);
		return true;
	}
	return false;
}

test("discovers a directory skill through a root-level symlink", async (t) => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const target = join(home, "linked", "directory-skill");
		const link = join(globalSkills, "directory-skill");
		await createSkillFile(join(target, "SKILL.md"), "directory-skill");

		try {
			await createDirectoryLink(target, link);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await new SkillManager(home).list();
		const skill = result.skills.find((item) => item.path === join(link, "SKILL.md"));
		assert.ok(skill);
		assert.equal(skill.type, "directory");
		assert.equal(skill.name, "directory-skill");
	});
});

test("discovers a root markdown skill through a file symlink", async (t) => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const target = join(home, "linked", "root-skill.md");
		const link = join(globalSkills, "root-skill.md");
		await createSkillFile(target, "root-skill");

		try {
			await createFileLink(target, link);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await new SkillManager(home).list();
		const skill = result.skills.find((item) => item.path === link);
		assert.ok(skill);
		assert.equal(skill.type, "markdown");
		assert.equal(skill.name, "root-skill");
	});
});

test("discovers a nested skill through a directory symlink", async (t) => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const parent = join(globalSkills, "collection");
		const target = join(home, "linked", "nested-skill");
		const link = join(parent, "nested-skill");
		await mkdir(parent, { recursive: true });
		await createSkillFile(join(target, "SKILL.md"), "nested-skill");

		try {
			await createDirectoryLink(target, link);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await new SkillManager(home).list();
		const skill = result.skills.find((item) => item.path === join(link, "SKILL.md"));
		assert.ok(skill);
		assert.equal(skill.name, "nested-skill");
	});
});

test("does not recurse forever through a directory symlink cycle", async () => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const cycleRoot = join(globalSkills, "cycle");
		await createSkillFile(join(cycleRoot, "visible", "SKILL.md"), "visible-skill");
		try {
			await createDirectoryLink(cycleRoot, join(cycleRoot, "loop"));
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await Promise.race([
			new SkillManager(home).list(),
			new Promise((_, reject) => setTimeout(() => reject(new Error("scan timed out")), 1000)),
		]);
		assert.ok(result.skills.some((item) => item.name === "visible-skill"));
	});
});

async function findSkill(home, skillPath) {
	const { SkillManager } = loadSkillManagerModule();
	const manager = new SkillManager(home);
	const { skills } = await manager.list();
	const skill = skills.find((item) => item.path === skillPath);
	assert.ok(skill, `skill not discovered: ${skillPath}`);
	return { manager, skill };
}

test("renames a directory skill and rewrites a normalized frontmatter name", async () => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const skillPath = join(globalSkills, "old-skill", "SKILL.md");
		await createSkillFile(skillPath, "old-skill");

		const { manager, skill } = await findSkill(home, skillPath);
		const renamed = await manager.rename(skill.path, "New Skill");

		assert.equal(renamed.path, join(globalSkills, "new-skill", "SKILL.md"));
		assert.equal(renamed.name, "new-skill");
		assert.equal(existsSync(join(globalSkills, "old-skill")), false);
		assert.match(await readFile(renamed.path, "utf8"), /name: new-skill/);
	});
});

test("renames a root markdown skill without moving the skill root", async () => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const skillPath = join(globalSkills, "note.md");
		await createSkillFile(skillPath, "note");

		const { manager, skill } = await findSkill(home, skillPath);
		assert.equal(skill.type, "markdown");
		const renamed = await manager.rename(skill.path, "memo");

		assert.equal(renamed.path, join(globalSkills, "memo.md"));
		assert.equal(existsSync(join(globalSkills, "memo.md")), true);
		assert.equal(existsSync(join(globalSkills, "note.md")), false);
		// 关键回归：位置根目录本身绝不能被改名/移动
		assert.equal(existsSync(globalSkills), true);
		assert.ok((await readdir(globalSkills)).includes("memo.md"));
	});
});

test("rejects rename onto an existing skill", async () => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const skillPath = join(globalSkills, "a", "SKILL.md");
		await createSkillFile(skillPath, "a");
		await createSkillFile(join(globalSkills, "b", "SKILL.md"), "b");

		const { manager, skill } = await findSkill(home, skillPath);
		await assert.rejects(() => manager.rename(skill.path, "b"));
		assert.equal(existsSync(join(globalSkills, "a", "SKILL.md")), true);
	});
});

test("rejects an unchanged name", async () => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const skillPath = join(globalSkills, "same", "SKILL.md");
		await createSkillFile(skillPath, "same");

		const { manager, skill } = await findSkill(home, skillPath);
		await assert.rejects(() => manager.rename(skill.path, "same"));
		assert.equal(existsSync(skillPath), true);
	});
});

test("adds a missing name line", async () => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const skillPath = join(globalSkills, "x", "SKILL.md");
		await mkdir(join(globalSkills, "x"), { recursive: true });
		await writeFile(skillPath, "---\ndescription: no name here\n---\n\n# x\n", "utf8");

		const { manager, skill } = await findSkill(home, skillPath);
		const renamed = await manager.rename(skill.path, "y");

		assert.equal(renamed.path, join(globalSkills, "y", "SKILL.md"));
		assert.match(await readFile(renamed.path, "utf8"), /name: y/);
	});
});
