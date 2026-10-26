import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";
import test from "node:test";
import {
	NODE_PTY_RUNTIME_FILES,
	SQL_JS_RUNTIME_FILES,
	stageNativeRuntime,
} from "../scripts/stage-native-runtime.mjs";

async function put(path, content = "runtime") {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function withTempProject(run) {
	const projectRoot = await mkdtemp(join(tmpdir(), "pideck-native-runtime-test-"));
	try {
		return await run(projectRoot);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
}

// Independent fixture contract: do not derive required files from the stager's allowlist.
const WINDOWS_PTY_FILES = [
	"conpty_console_list.node", "conpty.node", "pty.node", "winpty-agent.exe",
	"winpty.dll", "conpty/conpty.dll", "conpty/OpenConsole.exe",
];
const PREBUILT_DIR = `prebuilds/${process.platform}-${process.arch}`;

async function createRuntimeFixture(projectRoot, layout = "build/Release") {
	const nodePtyRoot = join(projectRoot, "node_modules", "node-pty");
	await put(join(nodePtyRoot, "package.json"), '{"main":"./lib/index.js"}');
	await put(join(nodePtyRoot, "lib", "index.js"));
	await put(join(nodePtyRoot, "lib", "utils.js"));
	await put(join(nodePtyRoot, "lib", "terminal.test.js"), "test");
	await put(join(nodePtyRoot, "lib", "index.js.map"), "source map");
	for (const file of WINDOWS_PTY_FILES) await put(join(nodePtyRoot, layout, file));
	await put(join(nodePtyRoot, "build", "Release", "unused.pdb"), "debug symbols");
	await put(join(nodePtyRoot, "src", "native.cc"), "source");

	const sqlRoot = join(projectRoot, "node_modules", "sql.js");
	await put(join(sqlRoot, "package.json"), '{"main":"./dist/sql-wasm.js"}');
	for (const file of SQL_JS_RUNTIME_FILES.filter((file) => file !== "package.json")) {
		await put(join(sqlRoot, file));
	}
	await put(join(sqlRoot, "dist", "sql-wasm-debug.js"), "debug build");
	await put(join(sqlRoot, "dist", "sql-wasm-debug.wasm"), "debug wasm");
	await put(join(sqlRoot, "dist", "sql-asm.js"), "asm build");

	const undiciRoot = join(projectRoot, "node_modules", "undici");
	await put(join(undiciRoot, "package.json"), '{"main":"index.js"}');
	await put(join(undiciRoot, "index.js"));
	await put(join(undiciRoot, "index-fetch.js"));
	await put(join(undiciRoot, "lib", "dispatcher", "client.js"));
	await put(join(undiciRoot, "docs", "README.md"), "docs");
	await put(join(undiciRoot, "types", "index.d.ts"), "types");

	const acornRoot = join(projectRoot, "node_modules", "acorn");
	await put(join(acornRoot, "package.json"), '{"main":"dist/acorn.js"}');
	await put(join(acornRoot, "dist", "acorn.js"));
	await put(join(acornRoot, "dist", "acorn.d.ts"), "types");
	await put(join(acornRoot, "dist", "acorn.test.js"), "test");
	await put(join(acornRoot, "dist", "acorn.js.map"), "source map");

	return { nodePtyRoot, sqlRoot, undiciRoot, acornRoot };
}

test("native runtime staging copies only executable node-pty/sql.js/undici files", async () => {
	await withTempProject(async (projectRoot) => {
		const fixture = await createRuntimeFixture(projectRoot);
		const stageRoot = join(projectRoot, "release", "win-unpacked");
		const stale = join(stageRoot, "app", "node_modules", "node-pty", "stale.pdb");
		await put(stale, "stale");

		const result = await stageNativeRuntime({ projectRoot, stageRoot });
		assert.equal(result.counts.nodePty, NODE_PTY_RUNTIME_FILES.length + 3);
		assert.equal(result.counts.sqlJs, SQL_JS_RUNTIME_FILES.length);
		assert.equal(result.counts.undici, 3);
		assert.equal(result.counts.extensionUndici, 3);
		assert.equal(result.counts.extensionAcorn, 2);

		for (const file of WINDOWS_PTY_FILES) {
			assert.equal(await exists(join(stageRoot, "app", "node_modules", "node-pty", "build/Release", file)), true, file);
		}
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "node-pty", "stale.pdb")), false);
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "node-pty", "lib", "terminal.test.js")), false);
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "node-pty", "lib", "index.js.map")), false);
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "node-pty", "src", "native.cc")), false);
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "node-pty", "build", "Release", "unused.pdb")), false);

		for (const file of SQL_JS_RUNTIME_FILES) {
			assert.equal(await exists(join(stageRoot, "app", "node_modules", "sql.js", file)), true, file);
		}
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "sql.js", "dist", "sql-wasm-debug.js")), false);
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "sql.js", "dist", "sql-asm.js")), false);

		assert.equal(await exists(join(stageRoot, "app", "node_modules", "undici", "lib", "dispatcher", "client.js")), true);
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "undici", "index-fetch.js")), false);
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "undici", "docs", "README.md")), false);
		assert.equal(await exists(join(stageRoot, "app", "node_modules", "undici", "types", "index.d.ts")), false);
		assert.equal(
			await readFile(join(stageRoot, "resources", "extensions", "node_modules", "undici", "package.json"), "utf8"),
			await readFile(join(fixture.undiciRoot, "package.json"), "utf8"),
		);
		assert.equal(await exists(join(stageRoot, "resources", "extensions", "node_modules", "acorn", "dist", "acorn.js")), true);
		assert.equal(await exists(join(stageRoot, "resources", "extensions", "node_modules", "acorn", "dist", "acorn.d.ts")), false);
		assert.equal(await exists(join(stageRoot, "resources", "extensions", "node_modules", "acorn", "dist", "acorn.test.js")), false);
		assert.equal(await exists(join(stageRoot, "resources", "extensions", "node_modules", "acorn", "dist", "acorn.js.map")), false);
		assert.equal(
			await readFile(join(stageRoot, "resources", "extensions", "node_modules", "acorn", "package.json"), "utf8"),
			await readFile(join(fixture.acornRoot, "package.json"), "utf8"),
		);
	});
});

test("native runtime staging supports host prebuilds without Release addons", async () => {
	await withTempProject(async (projectRoot) => {
		await createRuntimeFixture(projectRoot, PREBUILT_DIR);
		const stageRoot = join(projectRoot, "stage");
		await stageNativeRuntime({ projectRoot, stageRoot });
		for (const file of WINDOWS_PTY_FILES) {
			assert.equal(await exists(join(stageRoot, "app/node_modules/node-pty", PREBUILT_DIR, file)), true, file);
		}
	});
});

// Post-install leaves these Release DLLs even when install selected prebuilds.
test("native runtime staging ignores orphan Release DLLs and unrelated builds", async () => {
	await withTempProject(async (projectRoot) => {
		const { nodePtyRoot } = await createRuntimeFixture(projectRoot, PREBUILT_DIR);
		await put(join(nodePtyRoot, "build/Release/conpty/conpty.dll"), "orphan");
		await put(join(nodePtyRoot, "build/Release/conpty/OpenConsole.exe"), "orphan");
		for (const dir of ["build/Debug", "prebuilds/other-architecture"]) {
			for (const file of WINDOWS_PTY_FILES) await put(join(nodePtyRoot, dir, file));
		}
		await put(join(nodePtyRoot, PREBUILT_DIR, "conpty.pdb"));
		const stageRoot = join(projectRoot, "stage");
		await stageNativeRuntime({ projectRoot, stageRoot });
		const output = join(stageRoot, "app/node_modules/node-pty");
		for (const file of WINDOWS_PTY_FILES) assert.equal(await exists(join(output, PREBUILT_DIR, file)), true);
		for (const path of ["build", "prebuilds/other-architecture", `${PREBUILT_DIR}/conpty.pdb`]) {
			assert.equal(await exists(join(output, path)), false, path);
		}
	});
});

test("native runtime staging resolves mixed addons independently and prefers Release", async () => {
	await withTempProject(async (projectRoot) => {
		const { nodePtyRoot } = await createRuntimeFixture(projectRoot, PREBUILT_DIR);
		for (const file of ["pty.node", "winpty.dll", "winpty-agent.exe"]) {
			await put(join(nodePtyRoot, "build/Release", file), "release");
		}
		const stageRoot = join(projectRoot, "stage");
		await stageNativeRuntime({ projectRoot, stageRoot });
		const output = join(stageRoot, "app/node_modules/node-pty");
		for (const file of WINDOWS_PTY_FILES) {
			const release = ["pty.node", "winpty.dll", "winpty-agent.exe"].includes(file);
			assert.equal(await readFile(join(output, release ? "build/Release" : PREBUILT_DIR, file), "utf8"), release ? "release" : "runtime");
			assert.equal(await readFile(join(output, PREBUILT_DIR, file), "utf8"), "runtime", "keep the native loader's fallback");
			if (!release) assert.equal(await exists(join(output, "build/Release", file)), false);
		}
	});
});

for (const missing of WINDOWS_PTY_FILES) {
	test(`native runtime staging rejects missing prebuilt ${missing}`, async () => {
		await withTempProject(async (projectRoot) => {
			const { nodePtyRoot } = await createRuntimeFixture(projectRoot, PREBUILT_DIR);
			await rm(join(nodePtyRoot, PREBUILT_DIR, missing));
			await assert.rejects(stageNativeRuntime({ projectRoot, stageRoot: join(projectRoot, "stage") }), (error) => {
				assert.ok(error.message.includes("Missing node-pty runtime file:"));
				assert.ok(error.message.includes(join(nodePtyRoot, PREBUILT_DIR, missing)));
				return true;
			});
		});
	});
}

test("native runtime staging uses complete prebuilds instead of an incomplete Release group", async () => {
	await withTempProject(async (projectRoot) => {
		const { nodePtyRoot } = await createRuntimeFixture(projectRoot, PREBUILT_DIR);
		await put(join(nodePtyRoot, "build/Release/conpty.node"));
		const stageRoot = join(projectRoot, "stage");
		await stageNativeRuntime({ projectRoot, stageRoot });
		const output = join(stageRoot, "app/node_modules/node-pty");
		assert.equal(await exists(join(output, "build/Release/conpty.node")), false, "never ship an addon without its own companions");
		for (const file of WINDOWS_PTY_FILES) assert.equal(await exists(join(output, PREBUILT_DIR, file)), true, file);
	});
});

test("the staged native loader retains its prebuilt fallback when Release cannot be loaded", async () => {
	await withTempProject(async (projectRoot) => {
		const { nodePtyRoot } = await createRuntimeFixture(projectRoot, PREBUILT_DIR);
		for (const file of WINDOWS_PTY_FILES) await put(join(nodePtyRoot, "build/Release", file), "invalid release addon");
		// Use the dependency's real directory-selection code, replacing only native dlopen.
		const loader = await readFile(new URL("../node_modules/node-pty/lib/utils.js", import.meta.url), "utf8");
		await put(join(nodePtyRoot, "lib/utils.js"), loader);
		const stageRoot = join(projectRoot, "stage");
		await stageNativeRuntime({ projectRoot, stageRoot });
		const output = join(stageRoot, "app/node_modules/node-pty");
		const exports = {};
		vm.runInNewContext(await readFile(join(output, "lib/utils.js"), "utf8"), {
			exports, process: { platform: process.platform, arch: process.arch },
			require: (specifier) => {
				const content = readFileSync(resolve(output, "lib", specifier), "utf8");
				if (content === "invalid release addon") {
					const error = new Error("incompatible native addon");
					error.code = "ERR_DLOPEN_FAILED";
					throw error;
				}
				return { content };
			},
		});
		for (const name of ["conpty", "conpty_console_list", "pty"]) {
			const loaded = exports.loadNativeModule(name);
			assert.equal(loaded.dir, `../${PREBUILT_DIR}/`);
			assert.equal(loaded.module.content, "runtime");
		}
	});
});
