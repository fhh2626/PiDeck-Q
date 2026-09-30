import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ProjectStore } = loadTsCommonJs("src/main/projects/ProjectStore.ts");

test("corrupt project catalog is preserved before a new catalog is written", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-projects-"));
	try {
		const projectsFile = join(root, "projects.json");
		await writeFile(projectsFile, "{\"projects\":");
		const store = new ProjectStore({
			projectsFile,
			chatPathFile: join(root, "chat-path.json"),
			defaultChatProjectPath: join(root, "chat"),
		});
		await store.load();
		const preserved = await readFile(`${projectsFile}.corrupt`, "utf8");
		const rewritten = JSON.parse(await readFile(projectsFile, "utf8"));
		assert.equal(preserved, "{\"projects\":");
		assert.equal(Array.isArray(rewritten), true);
		assert.equal(rewritten.some((project) => project.id === "builtin-chat"), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failed corrupt catalog preservation does not overwrite the damaged primary", async () => {
 const root = await mkdtemp(join(tmpdir(), "pideck-projects-backup-failure-"));
 try {
  const projectsFile = join(root, "projects.json"); const damaged = '{"damaged":';
  await writeFile(projectsFile, damaged);
  const { ProjectStore: Store } = loadTsCommonJs("src/main/projects/ProjectStore.ts", {
   stubs: { "node:fs/promises": { ...fs, copyFile: async () => { throw Object.assign(new Error("backup denied"), { code: "EACCES" }); } } },
  });
  const store = new Store({ projectsFile, chatPathFile: join(root, "chat-path.json"), defaultChatProjectPath: join(root, "chat") });
  await assert.rejects(() => store.load(), /backup denied/);
  assert.equal(await readFile(projectsFile, "utf8"), damaged);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("repeated corruption preserves each damaged original without replacing old backups", async () => {
 const root = await mkdtemp(join(tmpdir(), "pideck-projects-backup-repeat-"));
 try {
  const projectsFile = join(root, "projects.json");
  const store = () => new ProjectStore({ projectsFile, chatPathFile: join(root, "chat-path.json"), defaultChatProjectPath: join(root, "chat") });
  await writeFile(projectsFile, '{"first":'); await store().load();
  await writeFile(projectsFile, '{"second":'); await store().load();
  assert.equal(await readFile(`${projectsFile}.corrupt`, "utf8"), '{"first":');
  const backups = (await readdir(root)).filter(name => name.startsWith("projects.json.corrupt"));
  assert.equal(backups.length, 2);
  const contents = await Promise.all(backups.map(name => readFile(join(root, name), "utf8")));
  assert.deepEqual(contents.sort(), ['{"first":', '{"second":']);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("an occupied corrupt backup directory does not prevent preserving a new original", async () => {
 const root = await mkdtemp(join(tmpdir(), "pideck-projects-backup-directory-"));
 try {
  const projectsFile = join(root, "projects.json"); await writeFile(projectsFile, '{"damaged":');
  await mkdir(`${projectsFile}.corrupt`);
  await new ProjectStore({ projectsFile, chatPathFile: join(root, "chat-path.json"), defaultChatProjectPath: join(root, "chat") }).load();
  const backups = (await readdir(root)).filter(name => name.startsWith("projects.json.corrupt."));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(root, backups[0]), "utf8"), '{"damaged":');
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed backup sync prevents project catalog reconstruction", async () => {
 const root = await mkdtemp(join(tmpdir(), "pideck-projects-backup-sync-"));
 try {
  const projectsFile = join(root, "projects.json"); await writeFile(projectsFile, '{"damaged":');
  const { ProjectStore: Store } = loadTsCommonJs("src/main/projects/ProjectStore.ts", {
   stubs: { "node:fs/promises": { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { close: () => handle.close(), sync: async () => { throw new Error("backup sync failed"); } };
   } } },
  });
  await assert.rejects(() => new Store({ projectsFile, chatPathFile: join(root, "chat-path.json"), defaultChatProjectPath: join(root, "chat") }).load(), /backup sync failed/);
  assert.equal(await readFile(projectsFile, "utf8"), '{"damaged":');
  assert.equal(await readFile(`${projectsFile}.corrupt`, "utf8"), '{"damaged":');
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed atomic project snapshot writes remove their temporary file", async () => {
 const root = await mkdtemp(join(tmpdir(), "pideck-projects-write-failure-"));
 try {
  const projectsFile = join(root, "projects.json");
  const { ProjectStore: Store } = loadTsCommonJs("src/main/projects/ProjectStore.ts", {
   stubs: { "node:fs/promises": { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { close: () => handle.close(), sync: () => handle.sync(), writeFile: async () => { throw new Error("write denied"); } };
   } } },
  });
  await assert.rejects(() => new Store({ projectsFile, chatPathFile: join(root, "chat-path.json"), defaultChatProjectPath: join(root, "chat") }).load(), /write denied/);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith(".tmp")), []);
  await assert.rejects(() => readFile(projectsFile), /ENOENT/);
 } finally { await rm(root, { recursive: true, force: true }); }
});
