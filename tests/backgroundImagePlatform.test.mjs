import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { BackgroundImageService } from "../src/main/backgrounds/BackgroundImageService.ts";
import { readFileSync as readFs, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const hostRequire = createRequire(import.meta.url);

// backgroundsIpc.ts 用无扩展名 import（shared/ipc），原生 strip-types 解析不了，
// 用 transpile + 递归 .ts require 加载（与 systemIpc 测试同手法）。
function transpile(src) {
	return ts.transpileModule(src, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
}
const _bgModCache = new Map();
function _bgBuildRequire(dir, overrides) {
	return (id) => {
		for (const k of Object.keys(overrides)) if (id.includes(k)) return overrides[k];
		if (id.startsWith("./") || id.startsWith("../")) {
			let b = pathResolve(dir, id);
			if (existsSync(`${b}.ts`)) b = `${b}.ts`;
			else if (existsSync(pathResolve(b, "index.ts"))) b = pathResolve(b, "index.ts");
			else if (existsSync(`${b}.js`)) b = `${b}.js`;
			return _bgLoadTs(b, overrides);
		}
		return hostRequire(id);
	};
}
function _bgLoadTs(fp, overrides = {}) {
	if (_bgModCache.has(fp)) return _bgModCache.get(fp);
	const src = readFs(fp, "utf8");
	const sb = {
		clearTimeout, setTimeout, process, exports: {},
		require: _bgBuildRequire(dirname(fp), overrides),
	};
	_bgModCache.set(fp, sb.exports);
	vm.runInNewContext(transpile(src), sb, { filename: fp });
	return sb.exports;
}
const { registerBackgroundsIpc } = _bgLoadTs("src/main/ipc/backgroundsIpc.ts");
const { ipcChannels } = _bgLoadTs("src/shared/ipc.ts");

test("BackgroundImageService: importImage, remove and old image trash cleanup", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-bg-"));
	const sourceImg = join(tempDir, "sample.png");
	await writeFile(sourceImg, "fake image content", "utf8");

	const trashed = [];
	const trashPath = async (p) => {
		trashed.push(p);
	};

	try {
		const service = new BackgroundImageService({
			directory: tempDir,
			trashPath,
			logger: null,
		});

		// 1. import first image
		const name1 = await service.importImage(sourceImg);
		assert.match(name1, /^bg-\d+\.png$/);
		const content1 = await readFile(join(tempDir, name1), "utf8");
		assert.equal(content1, "fake image content");

		// 2. import second image (should trash first image)
		const name2 = await service.importImage(sourceImg);
		assert.match(name2, /^bg-\d+\.png$/);
		assert.notEqual(name1, name2);
		assert.equal(trashed.includes(join(tempDir, name1)), true);

		// 3. remove second image
		await service.remove(name2);
		assert.equal(trashed.includes(join(tempDir, name2)), true);

		// 4. remove invalid name does nothing
		const prevLen = trashed.length;
		await service.remove("../../../etc/passwd");
		assert.equal(trashed.length, prevLen);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("BackgroundImageService: same-millisecond imports receive distinct names", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-bg-same-ms-"));
	const sourceImg = join(tempDir, "sample.png");
	await writeFile(sourceImg, "same millisecond", "utf8");
	const originalDateNow = Date.now;
	try {
		Date.now = () => 1_700_000_000_000;
		const trashed = [];
		const service = new BackgroundImageService({
			directory: tempDir,
			trashPath: async (p) => trashed.push(p),
			logger: null,
		});

		const name1 = await service.importImage(sourceImg);
		const name2 = await service.importImage(sourceImg);

		assert.equal(name1, "bg-1700000000000.png");
		assert.equal(name2, "bg-1700000000001.png");
		assert.equal(trashed.includes(join(tempDir, name1)), true);
		assert.equal(await readFile(join(tempDir, name2), "utf8"), "same millisecond");
	} finally {
		Date.now = originalDateNow;
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("BackgroundImageService: importImage with empty path returns ''", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-bg-empty-"));
	try {
		const service = new BackgroundImageService({
			directory: tempDir,
			trashPath: async () => {},
			logger: null,
		});
		const name = await service.importImage("");
		assert.equal(name, "");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("BackgroundImageService: importImage with missing source (copy failure) returns ''", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-bg-missing-"));
	try {
		const service = new BackgroundImageService({
			directory: tempDir,
			trashPath: async () => {},
			logger: null,
		});
		// 源文件不存在 → copyFile reject → 被 catch 吞掉 → 返回 ''
		const name = await service.importImage(join(tempDir, "does-not-exist.png"));
		assert.equal(name, "");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("BackgroundImageService: old-image trash failure does not block the new image", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-bg-trashfail-"));
	const sourceImg = join(tempDir, "sample.png");
	await writeFile(sourceImg, "img", "utf8");
	try {
		let trashCall = 0;
		const trashPath = async (p) => {
			trashCall += 1;
			// 第二次 trash（清理旧图）时抛错，不应阻塞新图
			if (trashCall > 0 && p.includes("bg-")) {
				// 第一次 import 的清理也会命中，但只有第二次 import 才有旧图
			}
			throw new Error("trash exploded");
		};
		const service = new BackgroundImageService({
			directory: tempDir,
			trashPath,
			logger: null,
		});
		// 第一次 import：目录里没有旧图，trash 不被调用
		const name1 = await service.importImage(sourceImg);
		assert.match(name1, /^bg-\d+\.png$/);
		// 第二次 import：有旧图 name1，trash(name1) 抛错，但新图仍应生效
		const name2 = await service.importImage(sourceImg);
		assert.match(name2, /^bg-\d+\.png$/);
		assert.notEqual(name1, name2);
		// 新图确实落盘
		assert.ok((await readFile(join(tempDir, name2), "utf8")).length > 0);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("BackgroundImageService: remove with absolute path or slash does not escape directory", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-bg-remove-"));
	const trashed = [];
	try {
		const service = new BackgroundImageService({
			directory: tempDir,
			trashPath: async (p) => {
				trashed.push(p);
			},
			logger: null,
		});
		// 合法名
		await service.remove("bg-123.png");
		assert.equal(trashed.length, 1);
		assert.equal(trashed[0], join(tempDir, "bg-123.png"));
		// 绝对路径：含 / 和盘符，正则 [a-zA-Z0-9.]+ 无 / → 拒绝
		await service.remove(join(tempDir, "bg-123.png"));
		assert.equal(trashed.length, 1, "absolute path should be rejected by the name regex");
		// 含斜杠
		await service.remove("bg-a/b.png");
		assert.equal(trashed.length, 1, "name with / should be rejected");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("registerBackgroundsIpc pickBackgroundImage: cancel returns '' and filters list all supported extensions", async () => {
	const handlers = new Map();
	const router = { handle: (ch, fn) => handlers.set(ch, fn) };
	const invoke = (ch, ...args) => handlers.get(ch)(...args);

	// 场景 A：dialog 取消
	let dialogOpts;
	const dialogs = {
		showOpenDialog: async (opts) => {
			dialogOpts = opts;
			return { canceled: true, filePaths: [] };
		},
	};
	const service = new BackgroundImageService({
		directory: join(tmpdir(), "unused"),
		trashPath: async () => {},
		logger: null,
	});
	registerBackgroundsIpc(router, { dialogs, backgroundImageService: service });

	const picked = await invoke(ipcChannels.pickBackgroundImage);
	assert.equal(picked, "", "cancel should return empty string");
	// filters 必须包含全部支持的扩展名
	const exts = dialogOpts.filters[0].extensions;
	for (const e of ["png", "jpg", "jpeg", "webp", "gif", "avif"]) {
		assert.ok(exts.includes(e), `filters should include ${e}`);
	}

	// 场景 B：选中一个文件 → 走 importImage
	const imported = [];
	const service2 = {
		importImage: async (p) => {
			imported.push(p);
			return "bg-999.png";
		},
	};
	const handlers2 = new Map();
	const router2 = { handle: (ch, fn) => handlers2.set(ch, fn) };
	const dialogs2 = {
		showOpenDialog: async () => ({ canceled: false, filePaths: ["/sel/x.png"] }),
	};
	registerBackgroundsIpc(router2, { dialogs: dialogs2, backgroundImageService: service2 });
	const picked2 = await handlers2.get(ipcChannels.pickBackgroundImage)();
	assert.equal(picked2, "bg-999.png");
	assert.deepEqual(imported, ["/sel/x.png"]);
});
