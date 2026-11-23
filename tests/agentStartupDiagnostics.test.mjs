import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const rendererMainSource = readFileSync("src/renderer/src/main.tsx", "utf8");

test("renderer startup reports bootstrap mount and global errors", () => {
	assert.match(rendererMainSource, /Renderer bootstrap started/);
	assert.match(rendererMainSource, /Renderer React tree mounted/);
	// main.tsx 文案已从 "Renderer startup ..." 收敛为更通用的 runtime 前缀
	assert.match(rendererMainSource, /Renderer uncaught error/);
	assert.match(rendererMainSource, /Renderer React update depth diagnostic/);
	assert.match(rendererMainSource, /Maximum update depth exceeded/);
	assert.match(rendererMainSource, /lastUpdateDepthDiagnosticAt/);
	assert.match(rendererMainSource, /Renderer root element missing/);
	assert.match(rendererMainSource, /function dismissBootOverlay\(\)/);
	assert.match(rendererMainSource, /window\.setTimeout\(dismissBootOverlay, 1500\)/);
});
