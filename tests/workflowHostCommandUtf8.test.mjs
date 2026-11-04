import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);

/** Load the real command coordinator, substituting only the shell/process boundary. */
function loadHostCommand(emit) {
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
	const source = readFileSync("resources/extensions/pideck-q-subagents/src/workflows/host-command.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const exports = {};
	vm.runInNewContext(outputText, {
		exports, Buffer, process, setTimeout, clearTimeout,
		require(id) {
			if (id === "node:child_process") return { spawn() { queueMicrotask(() => emit(child)); return child; } };
			if (id.startsWith("node:")) return require(id);
			if (id === "../runs/shared/acceptance.ts") return { quoteExecutableForShell: (s) => s };
			if (id === "../runs/background/owned-process-tree.ts") return { createOwnedProcessTreeController() { throw new Error("unexpected process tree request"); } };
			if (id === "../runs/shared/single-output.ts") return { resolveSingleOutputClaimPath: (s) => s };
			if (id === "../shared/file-system-retry.ts") return { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS: [], runFileSystemOperationWithRetry: (fn) => fn() };
			throw new Error(`Unexpected dependency ${id}`);
		},
	}, { filename: "host-command.ts" });
	return exports;
}

async function execute(emit, verify, overrides = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-host-utf8-"));
	try {
		const { executeWorkflowHostCommand } = loadHostCommand(emit);
		const result = await executeWorkflowHostCommand({
			key: "check", params: { kind: "command", command: "fixture", timeoutMs: 2000 },
			cwd: root, defaultOutputPath: join(root, "output.txt"), signal: new AbortController().signal,
			...overrides,
		});
		await verify(result, readFileSync(result.outputPath, "utf8"));
	} finally { rmSync(root, { recursive: true, force: true }); }
}

test("host stdout/stderr preserve UTF-8 characters split at every byte boundary", async () => {
	const out = "中文输出😀";
	const err = "错误信息🎉";
	await execute((child) => {
		for (const byte of Buffer.from(out)) child.stdout.write(Buffer.from([byte]));
		for (const byte of Buffer.from(err)) child.stderr.write(Buffer.from([byte]));
		child.emit("close", 0);
	}, (result, saved) => {
		assert.equal(result.stdout, out);
		assert.equal(result.stderr, err);
		assert.equal(saved, out + err);
		assert.equal(result.state, "passed");
	});
});

test("stdout and stderr keep independent incomplete UTF-8 sequences", async () => {
	const out = Buffer.from("中");
	const err = Buffer.from("文");
	await execute((child) => {
		child.stdout.write(out.subarray(0, 1));
		child.stderr.write(err.subarray(0, 2));
		child.stdout.write(out.subarray(1));
		child.stderr.write(err.subarray(2));
		child.emit("close", 0);
	}, (result, saved) => {
		assert.equal(result.stdout, "中");
		assert.equal(result.stderr, "文");
		assert.equal(saved, "中文");
	});
});

test("host decoder flushes incomplete trailing bytes on close", async () => {
	await execute((child) => {
		child.stdout.write(Buffer.from([0xe4, 0xb8]));
		child.stderr.write(Buffer.from([0xf0, 0x9f]));
		child.emit("close", 1);
	}, (result, saved) => {
		assert.equal(result.stdout, "�");
		assert.equal(result.stderr, "�");
		assert.equal(saved, "��");
		assert.equal(result.state, "failed");
	});
});

test("host output limits stay byte-bounded without splitting an astral character", async () => {
	await execute((child) => {
		child.stdout.write(Buffer.from("a".repeat(4090) + "😀xyz"));
		child.stderr.write(Buffer.alloc(1024 * 1024 + 50, 0x62));
		child.emit("close", 0);
	}, (result, saved) => {
		assert.equal(Buffer.byteLength(result.stdout) <= 4096, true);
		assert.equal(Buffer.byteLength(result.stderr) <= 4096, true);
		assert.equal(Buffer.byteLength(saved) <= 1024 * 1024, true);
		assert.equal(result.stdout, "a".repeat(4090) + "...");
		assert.equal(result.state, "passed");
	});
});

test("large multilingual output remains bounded and preserves complete code points", async () => {
	const text = "中😀".repeat(200000);
	await execute((child) => {
		child.stdout.write(Buffer.from(text));
		child.emit("close", 0);
	}, (result, saved) => {
		for (const [value, limit] of [[result.stdout, 4096], [saved, 1024 * 1024]]) {
			assert.equal(Buffer.byteLength(value) <= limit, true);
			assert.equal(value.endsWith("..."), true);
			assert.equal(value.slice(0, -3), text.slice(0, value.length - 3));
			assert.equal(value.includes("�"), false);
			assert.equal(Buffer.from(value).toString("utf8"), value, "no unpaired surrogate is retained");
		}
	});
});

test("abort still closes and flushes the host output decoder", async () => {
	const controller = new AbortController();
	await execute((child) => {
		child.stdout.write(Buffer.from([0xe4, 0xb8]));
		controller.abort();
	}, (result, saved) => {
		assert.equal(result.state, "stopped");
		assert.equal(result.stdout, "�");
		assert.equal(saved, "�");
	}, { signal: controller.signal });
});
