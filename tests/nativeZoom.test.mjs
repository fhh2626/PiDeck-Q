import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import test from "node:test";

function loadZoom() {
	const source = ts.transpileModule(readFileSync("src/renderer/src/native/rendererZoom.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const document = { documentElement: { style: {} } };
	const module = { exports: {} };
	new Script(source).runInNewContext({ module, exports: module.exports, document, Number, String, Math });
	return { ...module.exports, document };
}

test("native renderer zoom applies the persisted 80%-150% range to the root", () => {
	const { applyRendererZoom, document } = loadZoom();
	applyRendererZoom(0.8);
	assert.equal(document.documentElement.style.zoom, "0.8");
	applyRendererZoom(1);
	assert.equal(document.documentElement.style.zoom, "1");
	applyRendererZoom(1.5);
	assert.equal(document.documentElement.style.zoom, "1.5");
	applyRendererZoom(2);
	assert.equal(document.documentElement.style.zoom, "1.5");
	applyRendererZoom(Number.NaN);
	assert.equal(document.documentElement.style.zoom, "1");
	applyRendererZoom(0.1);
	assert.equal(document.documentElement.style.zoom, "0.8");
});
