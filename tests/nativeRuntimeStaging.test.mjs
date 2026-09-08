import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

async function createRuntimeFixture(projectRoot) {
	const nodePtyRoot = join(projectRoot, "node_modules", "node-pty");
	await put(join(nodePtyRoot, "package.json"), '{"main":"./lib/index.js"}');
	await put(join(nodePtyRoot, "lib", "index.js"));
	await put(join(nodePtyRoot, "lib", "utils.js"));
	await put(join(nodePtyRoot, "lib", "terminal.test.js"), "test");
	await put(join(nodePtyRoot, "lib", "index.js.map"), "source map");
	for (const file of NODE_PTY_RUNTIME_FILES) await put(join(nodePtyRoot, file));
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

	return { nodePtyRoot, sqlRoot, undiciRoot };
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

		for (const file of NODE_PTY_RUNTIME_FILES) {
			assert.equal(await exists(join(stageRoot, "app", "node_modules", "node-pty", file)), true, file);
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
	});
});
