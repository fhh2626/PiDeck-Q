import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	isPwshAdapterProviderPath,
	reconcileChildEnvironments,
	SHELL_POLICY_OWNER_ENV,
} from "../childReconciliation.ts";

function makeAdapter(dir) {
	const adapterRoot = join(dir, "node_modules", "@99percentpeople", "pi-pwsh-adapter");
	mkdirSync(adapterRoot, { recursive: true });
	const adapterPath = join(adapterRoot, "index.js");
	writeFileSync(adapterPath, "// adapter\n", "utf8");
	writeFileSync(join(adapterRoot, "package.json"), JSON.stringify({ name: "@99percentpeople/pi-pwsh-adapter" }), "utf8");
	return adapterPath;
}

function workerCatalog(dir) {
	const worker = {
		name: "worker",
		aliases: [],
		runnerType: "native",
		tools: ["read", "bash"],
		filePath: join(dir, "worker.md"),
	};
	return { packageRoot: dir, agents: new Map([["worker", worker]]) };
}

function reconciliationOptions(dir, changePromptPath, catalog, ownerKey) {
	return {
		agentDir: dir,
		catalog,
		parentTools: [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
		],
		parentActiveTools: ["read", "bash"],
		platform: "win32",
		shellPolicy: { bash: true, powershell: false },
		shellPolicyOwnerKey: ownerKey,
		changePiPromptPath,
	};
}

test("reconciliation removes only stale pwsh-adapter paths previously managed by change-pi-prompt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-pwsh-migration-"));
	const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
	try {
		const stateDir = join(dir, "change-pi-prompt");
		mkdirSync(stateDir, { recursive: true });
		const changePromptPath = join(dir, "pideck-q-change-pi-prompt.ts");
		const adapterPath = makeAdapter(dir);
		const userPath = join(dir, "user-extension.js");
		writeFileSync(changePromptPath, "// prompt extension\n", "utf8");
		writeFileSync(userPath, "// user extension\n", "utf8");

		assert.equal(isPwshAdapterProviderPath(adapterPath), true);
		assert.equal(isPwshAdapterProviderPath(userPath), false);

		writeFileSync(join(stateDir, "managed-child-extensions.json"), JSON.stringify({
			version: 1,
			managedPaths: [changePromptPath, adapterPath],
		}), "utf8");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({
			subagents: {
				agentOverrides: {
					worker: { subagentOnlyExtensions: [changePromptPath, adapterPath, userPath] },
				},
			},
		}), "utf8");

		const result = await reconcileChildEnvironments(
			reconciliationOptions(dir, changePromptPath, workerCatalog(dir), "migration-test-parent"),
		);

		assert.equal(result?.changed, true);
		const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		const childExtensions = settings.subagents.agentOverrides.worker.subagentOnlyExtensions;
		assert.equal(childExtensions.includes(adapterPath), false);
		assert.equal(childExtensions.includes(changePromptPath), true);
		assert.equal(childExtensions.includes(userPath), true, "unmanaged user extensions must survive migration");

		const managed = JSON.parse(readFileSync(join(stateDir, "managed-child-extensions.json"), "utf8"));
		assert.equal(managed.managedPaths.includes(adapterPath), false);
		assert.equal(managed.managedPaths.includes(changePromptPath), true);
	} finally {
		if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
		else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unsafe settings keep stale adapter ownership for a later migration retry", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-pwsh-migration-retry-"));
	const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
	try {
		const stateDir = join(dir, "change-pi-prompt");
		mkdirSync(stateDir, { recursive: true });
		const changePromptPath = join(dir, "pideck-q-change-pi-prompt.ts");
		const adapterPath = makeAdapter(dir);
		writeFileSync(changePromptPath, "// prompt extension\n", "utf8");
		writeFileSync(join(stateDir, "managed-child-extensions.json"), JSON.stringify({
			version: 1,
			managedPaths: [changePromptPath, adapterPath],
		}), "utf8");
		writeFileSync(join(dir, "settings.json"), "{not valid json", "utf8");

		await reconcileChildEnvironments(
			reconciliationOptions(dir, changePromptPath, workerCatalog(dir), "migration-retry-parent"),
		);

		const managed = JSON.parse(readFileSync(join(stateDir, "managed-child-extensions.json"), "utf8"));
		assert.equal(managed.managedPaths.includes(adapterPath), true,
			"failed/unsafe settings migration must keep ownership so the next run can retry");
	} finally {
		if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
		else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
		rmSync(dir, { recursive: true, force: true });
	}
});
