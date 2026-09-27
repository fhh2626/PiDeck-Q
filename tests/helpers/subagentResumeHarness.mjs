/**
 * Behavioral harness for the subagent foreground-resume tests.
 *
 * The pi-subagents extension sources are loaded as real TypeScript modules via
 * `subagentGraphLoader.mjs` (only the runSync / async-execution boundaries and
 * the missing bare packages are replaced by doubles). This harness owns:
 *   - environment isolation (temp roots must be set before the graph computes
 *     its directory constants),
 *   - fixture construction (fake deps/ctx, seeded remembered foreground runs
 *     and on-disk async run fixtures),
 *   - the runSync / async-execution call recorders the tests assert against.
 *
 * Everything under test (resume dispatch, session lease, foreground control,
 * remembered runs, recovery descriptors) is the production implementation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Environment isolation (must run before any extension module is imported) ──
// DIRS/SESSION_LEASES_DIR/getAgentDir() capture env at module load, so these
// assignments happen at harness module evaluation time, before loadSubagentResumeGraph().
export const HARNESS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-resume-harness-"));
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(HARNESS_ROOT, "temp-root");
process.env.PI_CODING_AGENT_DIR = path.join(HARNESS_ROOT, "agent-dir");
// Keep the optional LLM intent arbiter out of behavioral tests.
process.env.PI_SUBAGENTS_LLM_INTENT_ARBITER = "0";
fs.mkdirSync(process.env.PI_SUBAGENTS_TEMP_ROOT, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const EXT = "../../resources/extensions/pideck-q-subagents/src";

let loadedGraph;

/** Load the real subagent-executor graph once. Subsequent calls return the same modules. */
export async function loadSubagentResumeGraph() {
	if (loadedGraph) return loadedGraph;
	const { installSubagentGraphLoader } = await import("./subagentGraphLoader.mjs");
	installSubagentGraphLoader();
	const [executor, config, topAsync, lease, types, externalJob, fanout, missions, nested] = await Promise.all([
		import(`${EXT}/runs/foreground/subagent-executor.ts`),
		import(`${EXT}/extension/config.ts`),
		import(`${EXT}/runs/background/top-level-async.ts`),
		import(`${EXT}/runs/shared/session-lease.ts`),
		import(`${EXT}/shared/types.ts`),
		import(`${EXT}/api/external-job-provider.ts`),
		import(`${EXT}/runs/shared/run-fanout-budget.ts`),
		import(`${EXT}/missions/lifecycle.ts`),
		import(`${EXT}/runs/shared/nested-events.ts`),
	]);
	const detachReconcile = await import("./subagentDetachReconcileDouble.mjs");
	loadedGraph = {
		createSubagentExecutor: executor.createSubagentExecutor,
		prepareWorkflowLaunchParams: executor.prepareWorkflowLaunchParams,
		resolveAsyncByDefault: config.resolveAsyncByDefault,
		applyForceTopLevelAsyncOverride: topAsync.applyForceTopLevelAsyncOverride,
		inspectSessionLease: lease.inspectSessionLease,
		DIRS: types.DIRS,
		TEMP_ROOT_DIR: types.TEMP_ROOT_DIR,
		createNestedRoute: nested.createNestedRoute,
		SUBAGENT_CONTROL_EVENT: types.SUBAGENT_CONTROL_EVENT,
		registerExternalJobProvider: externalJob.registerExternalJobProvider,
		createRunFanoutBudget: fanout.createRunFanoutBudget,
		// Mission binding reads are production code: tests use them to prove the
		// prelaunch binding is observable at the real async run id.
		readMissionBinding: missions.readMissionBinding,
		setDetachReconcileFailure: detachReconcile.setDetachReconcileFailure,
		clearDetachReconcileFailure: detachReconcile.clearDetachReconcileFailure,
	};
	return loadedGraph;
}

// ── runSync / async-execution call recorders ─────────────────────────────────
export const runSyncCalls = [];
export const asyncCalls = [];
let runSyncBehavior;
let asyncSingleBehavior;
let asyncChainBehavior;

/** Install the next runSync behavior (the double records every call). */
export function setRunSyncBehavior(behavior) {
	runSyncBehavior = behavior;
}

export function setAsyncBehaviors({ single, chain } = {}) {
	asyncSingleBehavior = single;
	asyncChainBehavior = chain;
}

export function resetDoubles() {
	runSyncCalls.length = 0;
	asyncCalls.length = 0;
	runSyncBehavior = undefined;
	asyncSingleBehavior = undefined;
	asyncChainBehavior = undefined;
}

globalThis.__subagentTestRunSync = (cwd, agents, agentName, task, options) => {
	runSyncCalls.push({ cwd, agents, agentName, task, options });
	if (!runSyncBehavior) throw new Error("runSync test double called without an installed setRunSyncBehavior handler.");
	return runSyncBehavior({ cwd, agents, agentName, task, options });
};

globalThis.__subagentTestAsync = {
	executeAsyncSingle(runId, params) {
		asyncCalls.push({ kind: "single", runId, params });
		// The real runner owns the capacity slot; release it like a completed launch
		// so later tests never inherit leaked slots.
		params?.activeAsyncCapacity?.rollback?.();
		if (!asyncSingleBehavior) throw new Error("executeAsyncSingle test double called without an installed setAsyncBehaviors handler.");
		return asyncSingleBehavior(runId, params);
	},
	executeAsyncChain(runId, params) {
		asyncCalls.push({ kind: "chain", runId, params });
		if (!asyncChainBehavior) throw new Error("executeAsyncChain test double called without an installed setAsyncBehaviors handler.");
		return asyncChainBehavior(runId, params);
	},
	buildAsyncRunnerSteps() {
		return [];
	},
};

// ── Fixtures ────────────────────────────────────────────────────────────────
let fixtureCounter = 0;

export function createFixture(graph, label = "fx") {
	const dir = fs.mkdtempSync(path.join(HARNESS_ROOT, `fx-${label}-${fixtureCounter++}-`));
	const projectDir = path.join(dir, "project");
	fs.mkdirSync(projectDir, { recursive: true });
	const parentSessionFile = path.join(dir, "parent-session.jsonl");
	fs.writeFileSync(parentSessionFile, "");
	const childSessionFile = path.join(dir, "child-session.jsonl");
	fs.writeFileSync(childSessionFile, "");
	const discoveredAgents = [
		{
			name: "worker",
			description: "test worker",
			systemPrompt: "DISCOVERED PROMPT",
			systemPromptMode: "append",
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: true,
			source: "project",
			filePath: path.join(dir, "worker.md"),
			tools: ["read", "write"],
		},
	];
	const state = {
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		asyncJobs: new Map(),
		currentSessionId: undefined,
	};
	const config = {
		// Raw global tool timeout; forwarded to runSync as configToolTimeoutMs.
		toolTimeoutMs: 9000,
	};
	const deps = {
		pi: {
			events: { emit() {} },
			getSessionName: () => undefined,
		},
		state,
		config,
		asyncByDefault: false,
		tempArtifactsDir: path.join(dir, "temp-artifacts"),
		getSubagentSessionRoot: () => path.join(dir, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: (cwd, scope, preferredModelProvider) => ({
			agents: [...discoveredAgents],
			agentDiagnostics: [],
			projectAgentsDir: null,
			cwd,
			scope,
			directories: [],
			modelScope: config.modelScope,
		}),
	};
	const ctx = {
		cwd: projectDir,
		sessionManager: {
			getSessionFile: () => parentSessionFile,
			getSessionId: () => "parent-session-id",
		},
		modelRegistry: { getAvailable: () => [] },
		hasUI: false,
	};
	return { dir, projectDir, parentSessionFile, childSessionFile, discoveredAgents, state, config, deps, ctx };
}

/** Seed a completed remembered foreground run, the resume source for foreground targets. */
export function seedCompletedForegroundRun(fixture, { runId, resumeContract, agent = "worker" }) {
	fixture.state.foregroundRuns.set(runId, {
		runId,
		mode: "single",
		cwd: fixture.projectDir,
		sessionId: fixture.parentSessionFile,
		updatedAt: Date.now(),
		children: [
			{
				agent,
				index: 0,
				status: "completed",
				sessionFile: fixture.childSessionFile,
				finalOutput: "seed output",
				...(resumeContract ? { resumeContract } : {}),
			},
		],
	});
}

/**
 * Write an on-disk async run fixture (status.json + optional recovery descriptor),
 * the resume source for async targets (including external-job).
 */
export function seedAsyncRun(graph, fixture, { runId, agent = "worker", runState = "complete", runner, externalJob, recoveryDescriptor }) {
	const asyncDir = path.join(graph.DIRS.async, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	const status = {
		runId,
		sessionId: fixture.parentSessionFile,
		state: runState,
		mode: "single",
		cwd: fixture.projectDir,
		sessionFile: fixture.childSessionFile,
		timestamp: Date.now(),
		steps: [
			{
				agent,
				status: "complete",
				sessionFile: fixture.childSessionFile,
				...(runner ? { runner } : {}),
				...(externalJob ? { externalJob } : {}),
			},
		],
	};
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf8");
	if (recoveryDescriptor) {
		fs.writeFileSync(path.join(asyncDir, "recovery-descriptor.json"), JSON.stringify(recoveryDescriptor, null, 2), "utf8");
	}
	return asyncDir;
}

/** Minimal valid recovery descriptor; extras merge over the required fields. */
export function recoveryDescriptorFor(graph, fixture, runId, extras = {}) {
	return {
		version: 1,
		sourceRunId: runId,
		agent: "worker",
		cwd: fixture.projectDir,
		systemPromptMode: "replace",
		systemPrompt: "RECOVERED PROMPT",
		tools: ["read"],
		outputMode: "inline",
		maxSubagentDepth: 0,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		share: false,
		// readAsyncRecoveryDescriptor validates the descriptor against the on-disk
		// fan-out manifest, so a real budget descriptor is part of any valid fixture.
		runFanoutBudget: graph.createRunFanoutBudget(runId, 4),
		...extras,
	};
}

/** A background-launch success result matching executeAsyncSingle's contract. */
export function asyncStartedResult(runId, asyncDirOverride) {
	const asyncDir = asyncDirOverride ?? path.join(HARNESS_ROOT, `async-dir-${runId}`);
	return { content: [{ type: "text", text: `Async run '${runId}' started.` }], isError: false, details: { mode: "single", results: [], asyncId: runId, asyncDir } };
}

/**
 * Seed the minimal on-disk scene a workflow-owned async child leaves behind so
 * `waitForImportedAsyncRoot` can resolve it: the awaited root result file in the
 * real async run directory returned to the workflow. The file name mirrors the
 * production `workflowAwaitedAsyncResultPath` contract.
 */
export function seedAwaitedAsyncRootResult(asyncDir, output = "ASYNC ROOT COMPLETED") {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "workflow-result.json"),
		JSON.stringify({ state: "complete", success: true, summary: output }, null, 2),
		"utf8",
	);
}

/** A completed SingleResult shape for the runSync double. */
export function completedResult(fixture, overrides = {}) {
	return {
		agent: "worker",
		task: "follow-up",
		exitCode: 0,
		finalOutput: "resumed output",
		sessionFile: fixture.childSessionFile,
		progressSummary: { toolCount: 1, tokens: 10, durationMs: 5 },
		progress: { index: 0, agent: "worker", status: "completed", task: "follow-up", recentTools: [], recentOutput: [], toolCount: 1, tokens: 10, durationMs: 5 },
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		...overrides,
	};
}
