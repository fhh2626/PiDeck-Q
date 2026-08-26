import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surfaceSource = readFileSync("native/src/MainWebSurface.cpp", "utf8");

test("embedded QWebView visibility remains owned by its window container", () => {
	assert.doesNotMatch(surfaceSource, /\bm_view->show\(\)/);
});

test("embedded QWebView focus is delegated to the window container", () => {
	assert.match(surfaceSource, /m_container->setFocus\(Qt::ActiveWindowFocusReason\);/);
	assert.doesNotMatch(surfaceSource, /\bm_view->requestActivate\(\)/);
});
