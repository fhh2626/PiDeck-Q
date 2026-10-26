import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/piFixtureResolver.mjs";

const { createDefaultChildSessionFactory } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/child-session.ts");
const KEY = "PIDECK_TEST_CHILD_WINDOW";
const ABSENT = "PIDECK_TEST_CHILD_ABSENT";

/** Only the Pi SDK is substituted; the actual child-session factory owns env application/serialization. */
function fakePi(stage, snapshots = [], pauseReload) {
	const fail = (name) => { if (stage === name) throw new Error(`fixture ${name}`); };
	const runtime = {
		registerProvider() { fail("provider"); },
		registerNativeProvider() { fail("native-provider"); },
		async refresh() { fail("refresh"); },
	};
	const session = {
		async bindExtensions() { snapshots.push(["binding", process.env[KEY]]); fail("bind"); },
		dispose() {}, async abort() {},
		messages: [], sessionFile: undefined, sessionId: "fixture-session", model: undefined,
		extensionRunner: { hasHandlers() { return false; } },
	};
	return {
		ModelRuntime: { async create() { return runtime; } },
		SettingsManager: { create() { return { getTheme() { return "fixture"; } }; } },
		DefaultResourceLoader: class {
			loaded = false;
			async reload() {
				snapshots.push(["loading", process.env[KEY]]);
				fail("reload");
				await pauseReload?.();
			}
			getExtensions() {
				fail("get-extensions");
				return { runtime: {
					pendingProviderRegistrations: [{ name: "fixture", config: {}, extensionPath: "fixture" }],
					pendingNativeProviderRegistrations: [{ provider: {}, extensionPath: "fixture-native" }],
				} };
			}
		},
		SessionManager: { inMemory() { fail("storage"); return {}; } },
		resolveCliModel() {
			fail("resolve");
			return stage === "resolve-error" ? { error: "fixture resolve-error" } : {};
		},
		async createAgentSession() { fail("create"); return { session }; },
	};
}

function launch(overrides = {}) {
	return {
		cwd: process.cwd(), storage: { kind: "memory" }, model: "fixture/model",
		extensionPaths: [], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true,
		runtime: {}, processEnv: { [KEY]: "child", [ABSENT]: "temporary" },
		onExtensionError(error) { throw error.error; },
		...overrides,
	};
}

async function withEnvironment(action) {
	const previous = { [KEY]: process.env[KEY], [ABSENT]: process.env[ABSENT] };
	process.env[KEY] = "parent";
	delete process.env[ABSENT];
	try { await action(); }
	finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	}
}

for (const stage of ["reload", "get-extensions", "provider", "native-provider", "refresh", "storage", "resolve", "resolve-error", "create", "bind"]) {
	test(`foreground child restores its environment after ${stage} fails`, async () => {
		await withEnvironment(async () => {
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi(stage) });
			try { await assert.rejects(factory.create(launch()), new RegExp(`fixture ${stage}`)); }
			finally { await factory.dispose(); }
			assert.equal(process.env[KEY], "parent");
			assert.equal(process.env[ABSENT], undefined, "new child-only env keys must be removed");
		});
	});
}

test("partial environment application failure restores already-applied keys", async () => {
	await withEnvironment(async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi() });
		try {
			await assert.rejects(factory.create(launch({ processEnv: {
				[KEY]: "child", [ABSENT]: { toString() { throw new Error("fixture env conversion"); } },
			} })), /fixture env conversion/);
		} finally { await factory.dispose(); }
		assert.equal(process.env[KEY], "parent");
		assert.equal(process.env[ABSENT], undefined);
	});
});

test("foreground success uses child env through bind, then restores the parent", async () => {
	await withEnvironment(async () => {
		const snapshots = [];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi(undefined, snapshots) });
		try {
			await factory.create(launch());
			assert.deepEqual(snapshots, [["loading", "child"], ["binding", "child"]]);
			assert.equal(process.env[KEY], "parent");
			assert.equal(process.env[ABSENT], undefined);
		} finally { await factory.dispose(); }
	});
});

test("runner with ambient extensions retains its child environment after binding", async () => {
	await withEnvironment(async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi() });
		try {
			await factory.create(launch({ ambientExtensions: true }));
			assert.equal(process.env[KEY], "child");
			assert.equal(process.env[ABSENT], "temporary");
		} finally { await factory.dispose(); }
	});
});

test("parallel foreground children serialize their environment windows through binding", async () => {
	await withEnvironment(async () => {
		let releaseReload;
		let markReloadStarted;
		const started = new Promise((resolve) => { markReloadStarted = resolve; });
		const held = new Promise((resolve) => { releaseReload = resolve; });
		const snapshots = [];
		const first = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi(undefined, snapshots, async () => {
			markReloadStarted();
			await held;
		}) });
		const second = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi(undefined, snapshots) });
		let firstResult;
		let secondResult;
		try {
			firstResult = first.create(launch({ processEnv: { [KEY]: "first" } }));
			await started;
			secondResult = second.create(launch({ processEnv: { [KEY]: "second" } }));
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(snapshots, [["loading", "first"]], "second child must wait for first binding/restoration");
			assert.equal(process.env[KEY], "first");
			releaseReload();
			await Promise.all([firstResult, secondResult]);
			assert.deepEqual(snapshots, [["loading", "first"], ["binding", "first"], ["loading", "second"], ["binding", "second"]]);
			assert.equal(process.env[KEY], "parent");
		} finally {
			releaseReload();
			await Promise.allSettled([firstResult, secondResult]);
			await Promise.all([first.dispose(), second.dispose()]);
		}
	});
});

test("a failed launch releases the startup queue before the next child starts", async () => {
	await withEnvironment(async () => {
		const snapshots = [];
		const first = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi("reload") });
		const second = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi(undefined, snapshots) });
		try {
			const results = await Promise.allSettled([
				first.create(launch()), second.create(launch({ processEnv: { [KEY]: "next-child" } })),
			]);
			assert.equal(results[0].status, "rejected");
			assert.equal(results[1].status, "fulfilled");
			assert.deepEqual(snapshots, [["loading", "next-child"], ["binding", "next-child"]]);
			assert.equal(process.env[KEY], "parent");
			assert.equal(process.env[ABSENT], undefined);
		} finally { await Promise.all([first.dispose(), second.dispose()]); }
	});
});
