import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PromptManager } = loadTsCommonJs("src/main/prompts/PromptManager.ts");
const { registerStoreIpc } = loadTsCommonJs("src/main/ipc/storeIpc.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

function createHarness(root, projects) {
	const trashed = [];
	const manager = new PromptManager(
		join(root, "home"),
		(key) => key,
		() => ({ hiddenBuiltinPromptNames: [] }),
		async () => undefined,
		{ trashPath: async (target) => { trashed.push(target); } },
		() => projects,
	);
	const handlers = new Map();
	registerStoreIpc(
		{ handle: (channel, handler) => handlers.set(channel, handler) },
		{
			promptManager: manager,
			skillManager: {},
			xuePromptManager: {},
			extensionManager: {},
			appLogger: { info() {}, warn() {}, error() {} },
			mainCopy: (key) => key,
		},
	);
	return { manager, handlers, trashed };
}

test("prompt IPC rejects paths outside the template roots", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-prompt-auth-"));
	const project = join(root, "project");
	try {
		const { handlers, trashed, manager } = createHarness(root, [project]);
		await mkdir(manager.getDir(), { recursive: true });
		await mkdir(join(project, ".pi", "prompts"), { recursive: true });
		const outside = join(root, "outside.txt");
		await writeFile(outside, "outside secret");
		const siblingDir = `${manager.getDir()}-sibling`;
		const siblingFile = join(siblingDir, "file.md");
		await mkdir(siblingDir, { recursive: true });
		await writeFile(siblingFile, "keep");

		await assert.rejects(() => handlers.get(ipcChannels.promptsEdit)(outside));
		assert.equal(await readFile(outside, "utf8"), "outside secret");
		await assert.rejects(() => handlers.get(ipcChannels.promptsEdit)(siblingFile, "overwritten"));
		assert.equal(await readFile(siblingFile, "utf8"), "keep");
		await assert.rejects(() => handlers.get(ipcChannels.promptsDelete)(siblingFile));
		assert.equal(trashed.length, 0);
		await assert.rejects(() => handlers.get(ipcChannels.promptsDeleteInProject)(project, "../../outside.txt"));
		await assert.rejects(() => handlers.get(ipcChannels.promptsDeleteInProject)(project, "..\\..\\outside.txt"));
		await assert.rejects(() => handlers.get(ipcChannels.promptsDeleteInProject)(project, outside));
		assert.deepEqual(trashed, []);
		assert.equal(await readFile(outside, "utf8"), "outside secret");

		const stranger = join(root, "stranger");
		await mkdir(stranger, { recursive: true });
		await assert.rejects(() => handlers.get(ipcChannels.promptsListByProject)(stranger));
		await assert.rejects(() => handlers.get(ipcChannels.promptsCreateInProject)(stranger, {
			name: "x",
			description: "desc",
		}));
		await assert.rejects(() => handlers.get(ipcChannels.promptsDeleteInProject)(stranger, "x.md"));
		await assert.rejects(() => handlers.get(ipcChannels.promptsRenameInProject)(stranger, "x", "y"));

		await handlers.get(ipcChannels.promptsEdit)(join(manager.getDir(), "global.md"), "---\ndescription: Global\n---\nbody");
		assert.equal(await handlers.get(ipcChannels.promptsEdit)(join(manager.getDir(), "global.md")), "---\ndescription: Global\n---\nbody");
		const created = await handlers.get(ipcChannels.promptsCreateInProject)(project, {
			name: "local",
			description: "Local template",
		});
		assert.equal(created.scope, "project");
		const listed = await handlers.get(ipcChannels.promptsListByProject)(project);
		assert.equal(listed.templates.length, 1);
		assert.equal(await handlers.get(ipcChannels.promptsEdit)(created.path), created.content);
		await handlers.get(ipcChannels.promptsRenameInProject)(project, "local", "renamed");
		await handlers.get(ipcChannels.promptsDeleteInProject)(project, "renamed.md");
		assert.equal(trashed.length, 1);

		await assert.rejects(() => handlers.get(ipcChannels.promptsDeleteInProject)(project, ""));
		await assert.rejects(() => handlers.get(ipcChannels.promptsEdit)(123));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("prompt reads do not follow a link out of the template directory", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-prompt-link-"));
	try {
		const { handlers, manager } = createHarness(root, []);
		await mkdir(manager.getDir(), { recursive: true });
		const outside = join(root, "secret.md");
		await writeFile(outside, "secret");
		const link = join(manager.getDir(), "linked.md");
		try {
			await symlink(outside, link, "file");
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) {
				context.skip("File symlinks are unavailable on this platform.");
				return;
			}
			throw error;
		}
		await assert.rejects(() => handlers.get(ipcChannels.promptsEdit)(link));
		await assert.rejects(() => handlers.get(ipcChannels.promptsEdit)(link, "changed"));
		assert.equal(await readFile(outside, "utf8"), "secret");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("renaming a global template never overwrites an existing one", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-prompt-rename-"));
	try {
		const { manager } = createHarness(root, []);
		await mkdir(manager.getDir(), { recursive: true });
		await writeFile(join(manager.getDir(), "alpha.md"), "---\ndescription: Alpha\n---\nA");
		await writeFile(join(manager.getDir(), "beta.md"), "---\ndescription: Beta\n---\nB");

		await assert.rejects(() => manager.rename("alpha", "beta"));
		// 冲突时两边内容都不能变
		assert.equal(await readFile(join(manager.getDir(), "alpha.md"), "utf8"), "---\ndescription: Alpha\n---\nA");
		assert.equal(await readFile(join(manager.getDir(), "beta.md"), "utf8"), "---\ndescription: Beta\n---\nB");

		const renamed = await manager.rename("alpha", "gamma");
		assert.equal(renamed.name, "gamma");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("renaming a project template never overwrites an existing one", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-prompt-rename-project-"));
	const project = join(root, "project");
	try {
		const { manager } = createHarness(root, [project]);
		const projectPrompts = join(project, ".pi", "prompts");
		await mkdir(projectPrompts, { recursive: true });
		await writeFile(join(projectPrompts, "alpha.md"), "---\ndescription: Alpha\n---\nA");
		await writeFile(join(projectPrompts, "beta.md"), "---\ndescription: Beta\n---\nB");

		await assert.rejects(() => manager.renameInProject(project, "alpha", "beta"));
		assert.equal(await readFile(join(projectPrompts, "alpha.md"), "utf8"), "---\ndescription: Alpha\n---\nA");
		assert.equal(await readFile(join(projectPrompts, "beta.md"), "utf8"), "---\ndescription: Beta\n---\nB");

		const renamed = await manager.renameInProject(project, "alpha", "gamma");
		assert.equal(renamed.name, "gamma");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const linkedDirectory of [".pi", "prompts"]) {
 test(`project prompt IPC rejects an external ${linkedDirectory} directory link`, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pideck-prompt-junction-"));
  const project = join(root, "project"); const outside = join(root, "outside");
  try {
   await mkdir(project); await mkdir(outside);
   const linkedRoot = linkedDirectory === ".pi" ? join(outside, "prompts") : outside;
   await mkdir(linkedRoot, { recursive: true });
   if (linkedDirectory === "prompts") await mkdir(join(project, ".pi"));
   try { await symlink(outside, linkedDirectory === ".pi" ? join(project, ".pi") : join(project, ".pi", "prompts"), "junction"); }
   catch (error) { if (["EPERM", "ENOTSUP"].includes(error.code)) { context.skip("Directory links unavailable."); return; } throw error; }
   await writeFile(join(linkedRoot, "secret.md"), "secret");
   const { handlers, trashed } = createHarness(root, [project]);
   await assert.rejects(() => handlers.get(ipcChannels.promptsListByProject)(project));
   await assert.rejects(() => handlers.get(ipcChannels.promptsCreateInProject)(project, { name: "new", description: "outside" }));
   await assert.rejects(() => handlers.get(ipcChannels.promptsEdit)(join(project, ".pi", "prompts", "secret.md")));
   await assert.rejects(() => handlers.get(ipcChannels.promptsRenameInProject)(project, "secret", "renamed"));
   await assert.rejects(() => handlers.get(ipcChannels.promptsDeleteInProject)(project, "secret.md"));
   assert.deepEqual(trashed, []);
   assert.equal(await readFile(join(linkedRoot, "secret.md"), "utf8"), "secret");
   await assert.rejects(() => readFile(join(linkedRoot, "new.md")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
 });
}

test("project template rename refuses a final file symlink", async (context) => {
 const root = await mkdtemp(join(tmpdir(), "pideck-prompt-rename-link-"));
 const project = join(root, "project");
 try {
  await mkdir(join(project, ".pi", "prompts"), { recursive: true });
  const outside = join(root, "secret.md"); await writeFile(outside, "secret");
  try { await symlink(outside, join(project, ".pi", "prompts", "linked.md"), "file"); }
  catch (error) { if (["EPERM", "ENOTSUP"].includes(error.code)) { context.skip("File symlinks unavailable."); return; } throw error; }
  const { handlers } = createHarness(root, [project]);
  await assert.rejects(() => handlers.get(ipcChannels.promptsRenameInProject)(project, "linked", "renamed"));
  assert.equal(await readFile(outside, "utf8"), "secret");
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("WSL mounted-drive aliases are authorized against registered host projects", { skip: process.platform !== "win32" }, async () => {
 const root = await mkdtemp(join(tmpdir(), "pideck-prompt-wsl-alias-")); const project = join(root, "project");
 try {
  await mkdir(project);
  const { toWslLinuxPath } = loadTsCommonJs("src/main/wsl/WslPaths.ts");
  const logicalPath = toWslLinuxPath(project, { distro: "Ubuntu" });
  const { manager, handlers } = createHarness(root, [logicalPath]);
  manager.configureWsl({ distro: "Ubuntu", windowsHome: join(root, "wsl-home"), linuxHome: "/home/user" });
  const created = await handlers.get(ipcChannels.promptsCreateInProject)(logicalPath, { name: "wsl", description: "WSL" });
  assert.equal((await handlers.get(ipcChannels.promptsListByProject)(project)).templates.length, 1);
  const logicalFile = toWslLinuxPath(created.path, { distro: "Ubuntu" });
  assert.equal(await handlers.get(ipcChannels.promptsEdit)(logicalFile), created.content);
  await assert.rejects(() => handlers.get(ipcChannels.promptsListByProject)("\\\\wsl$\\OtherDistro\\home\\user"));
 } finally { await rm(root, { recursive: true, force: true }); }
});
