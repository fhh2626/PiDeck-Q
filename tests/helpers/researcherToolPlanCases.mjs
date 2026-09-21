import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// Executed only by the bounded parent subprocess, before importing Pi or provider modules.
assert.equal(homedir(), process.env.RESEARCHER_TEST_HOME);
assert.equal(process.env.PI_CODING_AGENT_DIR, join(homedir(), ".pi", "agent"));
assert.notEqual(process.cwd(), resolve(import.meta.dirname, "../.."));
let networkAttempts = 0;
function denyNetwork() {
	networkAttempts++;
	throw new Error("Researcher fixture forbids network access");
}
globalThis.fetch = denyNetwork;
http.request = http.get = https.request = https.get = denyNetwork;
net.connect = net.createConnection = tls.connect = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
syncBuiltinESMExports();
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}\n");
writeFileSync(join(process.cwd(), ".pi", "settings.json"), "{}\n");

const { repo, runtimePath, withResearcherSession, relocateRuntimeImports } = await import("./researcherSessionFixture.mjs");
const { resolvePiLaunchToolPlan } = await import("../../resources/extensions/pideck-q-subagents/src/runs/shared/child-tool-plan.ts");
const { loadSubagentCatalog } = await import("../../resources/extensions/pideck-q-change-pi-prompt/subagentCatalog.ts");
const { reconcileChildEnvironments, resolveLoadableToolProvider } = await import("../../resources/extensions/pideck-q-change-pi-prompt/childReconciliation.ts");
const { loadExtensions } = await import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const catalogPath = resolve(repo, "resources/extensions/pideck-q-subagents");
const providers = [resolve(repo, "resources/extensions/pideck-q-websearch.ts"), resolve(repo, "resources/extensions/pideck-q-webfetch/dist/index.mjs")];
const changePiPromptPath = resolve(repo, "resources/extensions/pideck-q-change-pi-prompt.ts");
const catalog = loadSubagentCatalog(catalogPath);
const researcher = catalog.agents.get("researcher");
assert.ok(researcher);
const webTools = ["web_search", "webfetch"];

/** Keep requirements, exclusions and extension loading coupled through the production plan. */
function plan(extensions = providers, excludeTools = []) {
	return resolvePiLaunchToolPlan({ tools: researcher.tools, agentName: "researcher", extensions, excludeTools });
}

/** Each reconciliation scenario owns its settings; it cannot repair another scenario's missing providers. */
async function reconcile(parentTools, parentActiveTools, run) {
	const agentDir = mkdtempSync(join(tmpdir(), "researcher-reconcile-"));
	try {
		const result = await reconcileChildEnvironments({
			agentDir, catalog, parentTools, parentActiveTools, platform: process.platform,
			shellPolicy: { bash: false, powershell: false }, changePiPromptPath,
			shellPolicyOwnerKey: "researcher-test",
		});
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		await run(result.compatibilityStatus.get("researcher"), settings.subagents.agentOverrides.researcher);
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
}

test("Researcher catalog and launch allowlist baseline", () => {
	assert.deepEqual(researcher.tools, ["read", "write", ...webTools]);
	assert.deepEqual(plan().effectiveToolAllowlist, researcher.tools);
	assert.deepEqual(plan().requiredChildTools, researcher.tools);
});

test("Researcher positive: real provider metadata, reconciliation and production diagnostic callback", async () => {
	const { extensions, errors } = await loadExtensions(providers, process.cwd());
	assert.deepEqual(errors, []);
	const snapshot = extensions.flatMap((ext) => [...ext.tools.values()].map((tool) => ({
		name: tool.definition.name, sourceInfo: tool.sourceInfo,
	})));
	for (const [index, name] of webTools.entries()) {
		const tool = snapshot.find((entry) => entry.name === name);
		assert.ok(tool?.sourceInfo);
		assert.deepEqual(resolveLoadableToolProvider(name, snapshot), { loadable: true, providerPath: providers[index] });
	}
	await reconcile(snapshot, webTools, async (status, override) => {
		assert.deepEqual(status.missingTools, []);
		for (const provider of providers) assert.ok(override.subagentOnlyExtensions.includes(provider));
		const launch = resolvePiLaunchToolPlan({
			tools: researcher.tools, agentName: "researcher", extensions: [],
			subagentOnlyExtensions: override.subagentOnlyExtensions,
		});
		await withResearcherSession(launch, async ({ session, start }) => {
			assert.deepEqual(session.getActiveToolNames(), researcher.tools);
			await start([]);
		});
	});
});

test("Researcher A: absent providers produce real session startup diagnostic delivery", async () => {
	await reconcile([], [], async (status, override) => {
		assert.deepEqual(status.missingTools, webTools);
		const launch = resolvePiLaunchToolPlan({
			tools: researcher.tools, agentName: "researcher", extensions: [],
			subagentOnlyExtensions: override.subagentOnlyExtensions,
		});
		await withResearcherSession(launch, async ({ session, start }) => {
			assert.deepEqual(session.getActiveToolNames(), ["read", "write"]);
			await start(webTools);
		});
	});
});

test("Researcher B: successfully loaded empty provider produces diagnostic delivery", async () => {
	const dir = mkdtempSync(join(tmpdir(), "researcher-empty-provider-"));
	try {
		const provider = join(dir, "empty.ts");
		writeFileSync(provider, "export default function () {}\n");
		await withResearcherSession(plan([provider]), async ({ loaded, session, start }) => {
			const empty = loaded.extensions.find((ext) => ext.path === provider);
			assert.ok(empty, "empty provider must actually load");
			assert.equal(empty.tools.size, 0);
			assert.deepEqual(session.getActiveToolNames(), ["read", "write"]);
			await start(webTools);
		});
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Same assertion is used for both the real source and the old-registry-input mutant. */
async function verifyInactiveTool(runtime = runtimePath) {
	await withResearcherSession(plan(), async ({ session, start }) => {
		assert.ok(session.getActiveToolNames().includes("web_search"));
		session.setActiveToolsByName(["read", "write", "webfetch"]);
		assert.ok(session.getAllTools().some((tool) => tool.name === "web_search"));
		await start(["web_search"]);
		assert.deepEqual(session.getActiveToolNames(), ["read", "write", "webfetch"], "diagnostics must not reactivate a filtered tool");
	}, { runtime });
}

test("Researcher C: registered inactive required tool produces diagnostic delivery without reactivation", async () => {
	await verifyInactiveTool();
});

test("Researcher explicit excludeTools removes requirement and does not reactivate the tool", async () => {
	const launch = plan(providers, ["web_search"]);
	assert.deepEqual(launch.requiredChildTools, ["read", "write", "webfetch"]);
	await withResearcherSession(launch, async ({ session, start }) => {
		assert.deepEqual(session.getActiveToolNames(), ["read", "write", "webfetch"]);
		await start([]);
		assert.deepEqual(session.getActiveToolNames(), ["read", "write", "webfetch"]);
	});
});

test("Researcher C regression sensitivity rejects old getAllTools production-source input", async () => {
	const dir = mkdtempSync(join(tmpdir(), "researcher-runtime-mutant-"));
	try {
		const source = readFileSync(runtimePath, "utf8");
		const needle = "evaluateChildToolDiagnostic(config, activeTools)";
		assert.equal(source.split(needle).length, 2, "mutate exactly the production diagnostic input");
		const mutant = join(dir, "subagent-prompt-runtime.ts");
		writeFileSync(mutant, relocateRuntimeImports(source.replace(needle, "evaluateChildToolDiagnostic(config, pi.getAllTools().map((tool) => tool.name))")));
		// This is a newly executed sensitivity check, not a claim of historical first-red execution.
		await assert.rejects(verifyInactiveTool(mutant), {
			name: "AssertionError", message: "inactive required tool must produce a diagnostic",
		});
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Researcher fixture makes no network attempts", () => {
	assert.equal(networkAttempts, 0);
});
