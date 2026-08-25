import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const windowSource = readFileSync("native/src/MainWindow.cpp", "utf8");
const surfaceSource = readFileSync("native/src/MainWebSurface.cpp", "utf8");

test("native DevTools path uses public QWebView/WebView2 shortcuts only", () => {
	assert.match(windowSource, /toggleDevTools/);
	assert.match(windowSource, /Key_F12/);
	assert.match(windowSource, /QKeyEvent/);
	assert.doesNotMatch(windowSource, /QtWebView\/private|QWebEngine.*private/);
	assert.doesNotMatch(surfaceSource, /QtWebView\/private|QWebEngine.*private/);
});

test("native devtools is intentionally a manual WebView2 compatibility gate", () => {
	assert.match(windowSource, /replaceable[\s\S]*direct WebView2 surface/);
	assert.match(windowSource, /F12/);
});
