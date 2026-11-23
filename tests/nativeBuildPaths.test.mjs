import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const fixtures = [
	["native2CatalogConcurrencyParity.test.mjs", "PiDeck-SessionCatalogConcurrencyTest"],
	["native2CopyStreamWrite.test.mjs", "PiDeck-CopyStreamTest"],
	["nativeDesktopProxyPolicy.test.mjs", "PiDeck-DesktopProxyPolicyTest", "PIDECK_DESKTOP_PROXY_TEST_EXECUTABLE"],
	["nativeFilePathPolicy.test.mjs", "PiDeck-FilePathPolicyTest", "PIDECK_FILE_PATH_TEST_EXECUTABLE"],
	["nativeBackgroundWork.test.mjs", "PiDeck-BackgroundWorkTest", "PIDECK_BACKGROUND_WORK_TEST_EXECUTABLE"],
	["nativeTodoCommandProjection.test.mjs", "PiDeck-TodoCommandTest", "PIDECK_TODO_COMMAND_TEST_EXECUTABLE"],
	["native2TranscriptHistory.test.mjs", "PiDeck-TranscriptHistoryTest", "PIDECK_TRANSCRIPT_TEST_EXECUTABLE"],
	["native2SummaryCacheWriteOrder.test.mjs", "PiDeck-SummaryCacheWriteOrderTest", "PIDECK_SUMMARY_CACHE_TEST_EXECUTABLE"],
];

/** Evaluate each real fixture's discovery and required gate without launching a child. */
function inspectFixture(file, { platform, arch = "x64", artifacts, env = {} }) {
	const registered = [];
	const available = new Map(Object.entries(artifacts).map(([name, mtimeMs]) => [path.resolve(name), { mtimeMs }]));
	const fakeProcess = { platform, arch, env, cwd: () => process.cwd() };
	const register = (name, options, body) => {
		registered.push({ name, options: typeof options === "function" ? {} : options, body: body ?? options });
	};
	register.it = register;
	register.describe = (_name, _options, body) => body();
	const modules = new Map();
	const stubs = {
		"node:assert/strict": assert,
		"node:path": path,
		"node:os": { tmpdir: () => path.resolve("fixture-tmp") },
		"node:test": register,
		"node:fs": {
			existsSync: (name) => available.has(path.resolve(name)),
			statSync: (name) => available.get(path.resolve(name)) ?? { mtimeMs: 20 },
			readdirSync: () => ["component.cpp", "component.h"],
		},
		"node:child_process": {
			execFileSync: () => { throw new Error("Unexpected native process launch"); },
			spawnSync: () => { throw new Error("Unexpected native process launch"); },
		},
		"./helpers/loadTsCommonJs.mjs": { loadTsCommonJs: () => ({}) },
		"./helpers/todoExtensionHarness.mjs": {},
		"./helpers/native2BackendHarness.mjs": {},
		"./helpers/native2FakeProcess.mjs": {},
		"jotai/vanilla": {},
	};
	const evaluate = (source, filename) => {
		const module = { exports: {} };
		const code = ts.transpileModule(source, {
			fileName: `${filename}.ts`,
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
		}).outputText;
		const context = {
			module, exports: module.exports, process: fakeProcess,
			require: (name) => {
				if (Object.hasOwn(stubs, name)) return stubs[name];
				if (name === "./helpers/nativeBuildPaths.mjs") {
					if (!modules.has(name)) modules.set(name, evaluate(readFileSync("tests/helpers/nativeBuildPaths.mjs", "utf8"), name).exports);
					return modules.get(name);
				}
				throw new Error(`Unexpected fixture import: ${name}`);
			},
		};
		vm.runInNewContext(code, context, { filename });
		return { exports: module.exports, selection: context.selection };
	};
	try {
		const source = readFileSync(`tests/${file}`, "utf8");
		const { selection } = evaluate(`${source}\n;globalThis.selection = { executable, required: typeof required === "undefined" ? undefined : required };`, file);
		return { ...selection, registered };
	} catch (error) {
		return { error, registered };
	}
}

function buildPath(target, platform, arch = "x64", mode = "debug") {
	const directory = platform === "win32" ? "windows" : platform === "darwin" ? "macosx" : platform;
	return `build/${directory}/${arch}/${mode}/${target}${platform === "win32" ? ".exe" : ""}`;
}

async function assertRequiredFailure(result) {
	if (result.error) {
		assert.match(result.error.message, /fresh|stale|required/i);
		return;
	}
	assert.equal(result.executable == null, true, "an unavailable executable cannot fall back to another artifact");
	assert.equal(result.required, true);
	assert.ok(result.registered.length > 0);
	assert.equal(Boolean(result.registered[0].options.skip), false, "required fixtures must execute their failure gate");
	await assert.rejects(async () => result.registered[0].body({}), /fresh|stale|required/i);
}

for (const [file, target, pin] of fixtures) {
	test(`${target} chooses a fresh host build when platforms and architectures coexist`, () => {
		for (const [platform, arch] of [["win32", "x64"], ["linux", "x64"], ["linux", "arm64"], ["darwin", "arm64"]]) {
			const artifacts = Object.fromEntries([
				["win32", "x64"], ["linux", "x64"], ["linux", "arm64"], ["darwin", "arm64"],
			].map(([candidatePlatform, candidateArch]) => [buildPath(target, candidatePlatform, candidateArch), 30]));
			const result = inspectFixture(file, { platform, arch, artifacts });
			assert.ifError(result.error);
			assert.equal(result.executable, path.resolve(buildPath(target, platform, arch)), `${platform}/${arch}`);
		}
		const debug = buildPath(target, "linux");
		const release = buildPath(target, "linux", "x64", "release");
		const result = inspectFixture(file, {
			platform: "linux", artifacts: { [debug]: 10, [release]: 30, [buildPath(target, "win32")]: 30 },
		});
		assert.ifError(result.error);
		assert.equal(result.executable, path.resolve(release), "a stale debug build must not hide a fresh host release build");
	});

	test(`${target} refuses a foreign build under the required gate`, async () => {
		await assertRequiredFailure(inspectFixture(file, {
			platform: "linux", artifacts: { [buildPath(target, "win32")]: 30 },
			env: { PIDECK_REQUIRE_BACKEND_TESTS: "1" },
		}));
	});

	if (pin) test(`${target} honors an explicit pin and fails closed when it is missing or stale`, async () => {
		const pinned = path.resolve("custom-components", target);
		const host = buildPath(target, "linux");
		const env = { [pin]: pinned };
		const fresh = inspectFixture(file, { platform: "linux", artifacts: { [host]: 30, [pinned]: 30 }, env });
		assert.ifError(fresh.error);
		assert.equal(fresh.executable, pinned);
		for (const artifacts of [{ [host]: 30 }, { [host]: 30, [pinned]: 10 }]) {
			await assertRequiredFailure(inspectFixture(file, { platform: "linux", artifacts, env }));
		}
	});
}
