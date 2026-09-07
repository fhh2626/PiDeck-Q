import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const electronStub = { shell: { openPath: async () => "" }, app: { getPath: () => tmpdir() } };
const { PromptManager } = loadTsCommonJs("src/main/prompts/PromptManager.ts", {
	stubs: { electron: electronStub },
});

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
const preload = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
const promptsTab = readFileSync("src/renderer/src/config/PromptsTab.tsx", "utf8");
const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");

function createManager(dir, hidden = []) {
	const settings = { hiddenBuiltinPromptNames: [...hidden] };
	return {
		settings,
		manager: new PromptManager(
			dir,
			() => "Prompt operation failed.",
			() => settings,
			async (patch) => {
				Object.assign(settings, patch);
				return settings;
			},
		),
	};
}

test("deleting a builtin prompt persists a hide mark instead of a disk file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-builtin-prompts-"));
	try {
		const { settings, manager } = createManager(dir);
		const before = await manager.list();
		assert.equal(before.templates.some((item) => item.name === "commit"), true);
		assert.equal(before.hasHiddenBuiltins, false);

		await manager.delete("builtin://commit");
		assert.deepEqual([...settings.hiddenBuiltinPromptNames], ["commit"]);

		const after = await manager.list();
		assert.equal(after.templates.some((item) => item.name === "commit"), false);
		assert.equal(after.hasHiddenBuiltins, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("restoring default prompts clears hide marks so builtins reappear", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-restore-prompts-"));
	try {
		const { settings, manager } = createManager(dir, ["commit", "review", "unknown"]);
		assert.equal((await manager.list()).hasHiddenBuiltins, true);

		await manager.restoreHiddenBuiltins();
		assert.deepEqual([...settings.hiddenBuiltinPromptNames], []);

		const restored = await manager.list();
		assert.equal(restored.hasHiddenBuiltins, false);
		assert.equal(restored.templates.some((item) => item.name === "commit"), true);
		assert.equal(restored.templates.some((item) => item.name === "review"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prompt restore wiring stays on one IPC channel and settings hide list", () => {
	assert.match(settingsType, /hiddenBuiltinPromptNames: string\[\]/);
	assert.match(ipc, /promptsRestoreBuiltins: "prompts:restore-builtins"/);
	assert.match(storeIpc, /ipcChannels\.promptsRestoreBuiltins/);
	assert.match(preload, /restoreBuiltins:/);
	assert.match(promptsTab, /config\.restoreBuiltinPrompts/);
	assert.match(configModal, /restoreBuiltinPromptsBody/);
	assert.doesNotMatch(configModal, /deletedBuiltinNames/);
});
