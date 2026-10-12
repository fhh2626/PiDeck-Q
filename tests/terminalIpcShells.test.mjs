import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { registerTerminalIpc } = loadTsCommonJs("src/main/ipc/terminalIpc.ts");

test("terminal:shells is registered and returns terminalManager.listShells()", async () => {
	const handlers = new Map();
	const shells = [{ shell: "powershell", label: "PowerShell", available: true }];
	registerTerminalIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
		appLogger: { info: async () => undefined },
		sessionRuntimeCoordinator: { validateTarget: () => ({ ok: true }) },
		terminalManager: { listShells: () => shells },
		toSessionCommandIpcError: (error) => new Error(String(error)),
	});
	const handler = handlers.get(ipcChannels.terminalShells);
	assert.equal(typeof handler, "function");
	assert.deepEqual(await handler(), shells);
});
