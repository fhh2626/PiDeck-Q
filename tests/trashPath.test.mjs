import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// createTrashPath 统一回收站入口测试：
// 1) 正常转发到 platform.shell.trashItem，审计日志包含 path/source/count；
// 2) 回收站不可用时记录 error（含 path/source/error）并原样抛出原始错误；
// 3) 失败后绝不 fallback 到 rm/unlink 硬删（行为级断言，40G 误删教训的回归保障）。

const trashPathModule = "src/main/fs/trash.ts";

function compile(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: () => ({}),
		console,
	}, { filename: filePath });
	return module.exports;
}

test("trashPath 将目标路径转发给 trashItem 并记录 warn 日志", async () => {
	const calls = [];
	const logs = [];
	const trashItem = async (p) => {
		calls.push(p);
	};
	const logger = {
		warn: (cat, msg, meta) => logs.push({ level: "warn", cat, msg, meta }),
		error: (cat, msg, meta) => logs.push({ level: "error", cat, msg, meta }),
	};
	const { createTrashPath } = compile(trashPathModule);
	const trashPath = createTrashPath({ trashItem, logger });

	await trashPath("C:/some/user/file.txt", { source: "test:action", count: 1 });
	assert.deepEqual(calls, ["C:/some/user/file.txt"]);
	assert.equal(logs.length, 1);
	assert.equal(logs[0].level, "warn");
	assert.equal(logs[0].meta.source, "test:action");
});

test("trashPath 审计日志包含 path/source/count 完整字段", async () => {
	const logs = [];
	const logger = {
		warn: (cat, msg, meta) => logs.push({ level: "warn", cat, msg, meta }),
		error: (cat, msg, meta) => logs.push({ level: "error", cat, msg, meta }),
	};
	const { createTrashPath } = compile(trashPathModule);
	const trashPath = createTrashPath({
		trashItem: async () => {},
		logger,
	});

	await trashPath("C:/user/docs/report.docx", { source: "audit:case" });
	assert.equal(logs[0].meta.path, "C:/user/docs/report.docx");
	assert.equal(logs[0].meta.source, "audit:case");
	assert.equal(logs[0].meta.count, 1);

	await trashPath("C:/user/docs/a.txt", { source: "audit:batch", count: 3 });
	assert.equal(logs[1].meta.path, "C:/user/docs/a.txt");
	assert.equal(logs[1].meta.count, 3);

	// 未传 context 时回退为 unknown/1
	await trashPath("C:/user/docs/b.txt");
	assert.equal(logs[2].meta.source, "unknown");
	assert.equal(logs[2].meta.count, 1);
});

test("trashPath 在回收站不可用时记录 error 日志并抛错（拒绝静默硬删）", async () => {
	const logs = [];
	const trashItem = async () => {
		throw new Error("trash unavailable");
	};
	const logger = {
		warn: (cat, msg, meta) => logs.push({ level: "warn", cat, msg, meta }),
		error: (cat, msg, meta) => logs.push({ level: "error", cat, msg, meta }),
	};
	const { createTrashPath } = compile(trashPathModule);
	const trashPath = createTrashPath({ trashItem, logger });

	await assert.rejects(() => trashPath("C:/some/user/file.txt", { source: "test:action" }), /trash unavailable/);
	assert.equal(logs.length, 1);
	assert.equal(logs[0].level, "error");
});

test("失败时 error 日志包含 path/source/error 并原样抛出原始错误对象", async () => {
	const logs = [];
	const originalError = new Error("EBUSY: recycle bin locked");
	const trashItem = async () => {
		throw originalError;
	};
	const logger = {
		warn: () => {},
		error: (cat, msg, meta) => logs.push({ level: "error", cat, msg, meta }),
	};
	const { createTrashPath } = compile(trashPathModule);
	const trashPath = createTrashPath({ trashItem, logger });

	let caught;
	try {
		await trashPath("C:/user/data/keep-me.txt", { source: "fail:case" });
	} catch (error) {
		caught = error;
	}

	assert.ok(caught, "failure must reject");
	assert.equal(caught, originalError, "must rethrow the original error object, not a wrapped copy");

	assert.equal(logs.length, 1);
	assert.equal(logs[0].level, "error");
	assert.equal(logs[0].cat, "fs:trash");
	assert.equal(logs[0].meta.path, "C:/user/data/keep-me.txt");
	assert.equal(logs[0].meta.source, "fail:case");
	assert.match(String(logs[0].meta.error), /EBUSY: recycle bin locked/);
});

test("trashItem 失败后没有 rm/unlink 硬删 fallback（行为级断言）", async () => {
	// 回收站失败后唯一合法行为是记 error 并原样抛出。
	// 如果未来引入「回收站失败就永久删除」的兜底，实现必然需要引入文件系统删除能力：
	// 1) require fs 模块（此处监控）；2) 吞掉或包装原始错误（上方 identity 断言拦截）。
	const requiredModules = [];
	const source = readFileSync(trashPathModule, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: trashPathModule,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: (id) => {
			requiredModules.push(id);
			return {};
		},
		console,
	}, { filename: trashPathModule });

	const originalError = new Error("trash unavailable");
	let caught;
	try {
		await module.exports.createTrashPath({
			trashItem: async () => {
				throw originalError;
			},
			logger: { warn: () => {}, error: () => {} },
		})("C:/user/data/precious.txt", { source: "fallback:probe" });
	} catch (error) {
		caught = error;
	}

	assert.equal(caught, originalError, "failure must reject with the original error, never swallow it for a fallback");
	const fsRequires = requiredModules.filter((id) => id.includes("fs") || id.includes("electron"));
	assert.deepEqual(fsRequires, [], "trashPath must not depend on fs/electron; a deletion fallback would need them");
});
