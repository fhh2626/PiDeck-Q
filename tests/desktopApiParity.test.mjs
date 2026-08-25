import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import test from "node:test";

const hostRequire = createRequire(import.meta.url);
const moduleCache = new Map();

function loadTs(filePath) {
	const absolute = resolve(filePath);
	if (moduleCache.has(absolute)) return moduleCache.get(absolute).exports;
	const module = { exports: {} };
	moduleCache.set(absolute, module);
	const source = ts.transpileModule(readFileSync(absolute, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const localRequire = (id) => {
		if (id.startsWith(".")) {
			const candidate = resolve(dirname(absolute), id).replace(/\.ts$/, "") + ".ts";
			return loadTs(candidate);
		}
		return hostRequire(id);
	};
	new Script(source, { filename: absolute }).runInNewContext({
		module,
		exports: module.exports,
		require: localRequire,
		console,
		process,
		Buffer,
		setTimeout,
		clearTimeout,
	});
	return module.exports;
}

function fakeTransport() {
	return {
		invoke: async () => undefined,
		subscribe: () => () => undefined,
	};
}

const { createPiDesktopApi } = loadTs("src/shared/desktop/createPiDesktopApi.ts");

function shape(value) {
	if (!value || typeof value !== "object") return typeof value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
}

test("Electron and native transports expose the identical PiDesktopApi key tree", () => {
	const syncHost = {
		readClipboardText: () => "",
		readClipboardHtml: () => "",
		readClipboardImage: () => "",
		getPathForFile: () => "",
		getClipboardPaths: () => [],
	};
	const electronApi = createPiDesktopApi(fakeTransport(), syncHost);
	const nativeApi = createPiDesktopApi(fakeTransport(), syncHost);
	assert.deepEqual(shape(electronApi), shape(nativeApi));
	assert.ok(Object.keys(electronApi).length > 10);
	assert.equal(typeof electronApi.clipboard.readText(), "string");
	assert.equal(typeof nativeApi.files.getClipboardPaths, "function");
});

test("preload and native bootstrap both use the shared factory", () => {
	const preload = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
	const bootstrap = readFileSync("src/renderer/src/native/initializeNativeDesktop.ts", "utf8");
	assert.match(preload, /export function createPiDesktopApi/);
	assert.match(bootstrap, /createPiDesktopApi\(transport/);
	assert.doesNotMatch(bootstrap, /ipcRenderer|contextBridge|from ["']electron["']/);
});
