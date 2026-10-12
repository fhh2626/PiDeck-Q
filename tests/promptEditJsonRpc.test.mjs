import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PromptManager } = loadTsCommonJs("src/main/prompts/PromptManager.ts");
const { registerStoreIpc } = loadTsCommonJs("src/main/ipc/storeIpc.ts");
const { createPiDesktopApi } = loadTsCommonJs("src/shared/desktop/createPiDesktopApi.ts");

/** Exercise the desktop API through the JSON boundary, not direct handler calls. */
async function withPromptApi(run) {
	const root = await mkdtemp(join(tmpdir(), "pideck-prompt-edit-rpc-"));
	try {
		const manager = new PromptManager(
			join(root, "home"), (key) => key,
			() => ({ hiddenBuiltinPromptNames: [] }), async () => undefined,
			{ trashPath: async () => undefined }, () => [],
		);
		await mkdir(manager.getDir(), { recursive: true });
		const handlers = new Map();
		registerStoreIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
			promptManager: manager, skillManager: {}, xuePromptManager: {}, extensionManager: {},
			appLogger: { info() {}, warn() {}, error() {} }, mainCopy: (key) => key,
		});
		const api = createPiDesktopApi({
			invoke: async (channel, ...args) => {
				// HTTP RPC serializes missing array entries as null; reproduce that behavior.
				const request = JSON.parse(JSON.stringify({ channel, args }));
				return handlers.get(request.channel)(...request.args);
			},
			subscribe: () => () => undefined,
		});
		await run(api);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("new user prompt can be opened for editing through JSON RPC", async () => {
	await withPromptApi(async (api) => {
		const created = await api.prompts.create({ name: "editable", description: "User template" });
		assert.equal(await api.prompts.edit(created.path), created.content);
	});
});

test("prompt edit through JSON RPC saves content including an empty string", async () => {
	await withPromptApi(async (api) => {
		const created = await api.prompts.create({ name: "saveable", description: "User template" });
		await api.prompts.edit(created.path, "Updated template");
		assert.equal(await api.prompts.edit(created.path), "Updated template");
		await api.prompts.edit(created.path, "");
		assert.equal(await api.prompts.edit(created.path), "");
	});
});
