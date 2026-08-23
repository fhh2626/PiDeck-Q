import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * detectTrigger 回归：普通正文里的 @ / & 不能打开建议框，
 * 否则后续按键会被当成「还在引用会话/文件」，Esc/Enter 会改写正文，
 * 粘贴含 & 的文本后再输入也会把光标/文本搅乱。
 */
function loadAppUtils() {
	const source = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		location: { href: "file:///Users/test/app" },
		require: (id) => {
			if (id === "../session/composer/chips") {
				return { formatFilePathRef: (p, opts) => (opts?.isDirectory ? `@${p}/` : `@${p}`) };
			}
			return {};
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "AppUtils.ts" });
	return sandbox.exports;
}

const { detectTrigger, applySuggestion, clearSuggestionTrigger, MAX_TRIGGER_LOOKBACK } =
	loadAppUtils();

const sessions = new Set(["alpha", "beta long"]);

/** vm 跨 realm 时 deepEqual 会因原型不同误报，统一 JSON 比较。 */
function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function atEnd(text, refs = sessions) {
	return detectTrigger(text, text.length, refs);
}

test("plain prose ampersand does not open a session trigger", () => {
	assert.equal(atEnd("Tom & Jerry"), null);
	assert.equal(atEnd("A & B"), null);
	assert.equal(atEnd("use && to run both"), null);
	assert.equal(atEnd("https://ex.com?a=1&b=2"), null);
	assert.equal(atEnd("cmd&x"), null);
	assert.equal(atEnd("100% & more"), null);
});

test("session trigger stays open only while query is a prefix of a known session", () => {
	assertJsonEqual(atEnd("&"), { start: 0, char: "&", query: "" });
	assertJsonEqual(atEnd("see &al"), { start: 4, char: "&", query: "al" });
	assertJsonEqual(atEnd("&beta"), { start: 0, char: "&", query: "beta" });
	assertJsonEqual(atEnd("&beta l"), { start: 0, char: "&", query: "beta l" });
	assertJsonEqual(atEnd("&beta long"), { start: 0, char: "&", query: "beta long" });
	// 完整会话名后再跟空格/正文 = 引用已结束，不能继续钉住建议框
	assert.equal(atEnd("&beta long next"), null);
	assert.equal(atEnd("&ghost"), null);
	assert.equal(atEnd("&alpha "), null);
});

test("empty session whitelist treats & as ordinary text", () => {
	assert.equal(detectTrigger("&", 1, new Set()), null);
	assert.equal(detectTrigger("&alpha", 6, new Set()), null);
});

test("email and mid-word @ / slash are not mention triggers", () => {
	assert.equal(atEnd("user@host.com"), null);
	assert.equal(atEnd("and/or"), null);
	assert.equal(atEnd("src/index.ts"), null);
	assert.equal(atEnd("https://example.com/foo"), null);
	assert.equal(atEnd("C:/Users/me"), null);
});

test("intentional @file and /command triggers still work", () => {
	assertJsonEqual(atEnd("@"), { start: 0, char: "@", query: "" });
	assertJsonEqual(atEnd("see @src/a"), { start: 4, char: "@", query: "src/a" });
	assertJsonEqual(atEnd("/comp"), { start: 0, char: "/", query: "comp" });
	assert.equal(atEnd("@src/a 说明"), null);
});

test("applySuggestion does not rewrite ordinary ampersand prose", () => {
	const current = "A & B";
	const result = applySuggestion(current, current.length, "&alpha", sessions);
	assert.equal(result.text, "A & B&alpha ");
	assert.equal(result.cursor, result.text.length);
});

test("clearSuggestionTrigger only strips a fresh empty trigger", () => {
	assertJsonEqual(clearSuggestionTrigger("&", 1, sessions), { text: "", cursor: 0 });
	assertJsonEqual(clearSuggestionTrigger("see &al", 7, sessions), {
		text: "see &al",
		cursor: 7,
	});
	const prose = "A & B";
	assertJsonEqual(clearSuggestionTrigger(prose, prose.length, sessions), {
		text: prose,
		cursor: prose.length,
	});
});

test("P1: detectTrigger triggers at start and middle of document", () => {
	assertJsonEqual(atEnd("@foo"), { start: 0, char: "@", query: "foo" });
	assertJsonEqual(atEnd("hello @foo"), { start: 6, char: "@", query: "foo" });
	assertJsonEqual(atEnd("/command"), { start: 0, char: "/", query: "command" });
	assertJsonEqual(atEnd("@src/path"), { start: 0, char: "@", query: "src/path" });
	assert.equal(atEnd("@src/path trailing text"), null);
	assertJsonEqual(atEnd("&alpha"), { start: 0, char: "&", query: "alpha" });
	assert.equal(atEnd("https://site.org/docs/page"), null);
	assert.equal(atEnd("a/b"), null);
});

test("P1: detectTrigger with >100KB prefix text triggers with accurate absolute offset", () => {
	const prefix = "Some regular text without triggers. ".repeat(3000); // ~108 KB
	const offset = prefix.length;

	// @foo at end
	const atText = `${prefix}@foo`;
	assertJsonEqual(detectTrigger(atText, atText.length, sessions), {
		start: offset,
		char: "@",
		query: "foo",
	});

	// /command at end
	const slashText = `${prefix}/command`;
	assertJsonEqual(detectTrigger(slashText, slashText.length, sessions), {
		start: offset,
		char: "/",
		query: "command",
	});

	// &session at end
	const ampText = `${prefix}&alpha`;
	assertJsonEqual(detectTrigger(ampText, ampText.length, sessions), {
		start: offset,
		char: "&",
		query: "alpha",
	});

	// @src/path at end
	const pathText = `${prefix}@src/path`;
	assertJsonEqual(detectTrigger(pathText, pathText.length, sessions), {
		start: offset,
		char: "@",
		query: "src/path",
	});
});

test("P1: detectTrigger implementation does not full-slice and has MAX_TRIGGER_LOOKBACK constant", () => {
	assert.equal(typeof MAX_TRIGGER_LOOKBACK, "number");
	assert.ok(MAX_TRIGGER_LOOKBACK >= 512, "MAX_TRIGGER_LOOKBACK should be sufficiently large");

	const appUtilsSource = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
	assert.equal(
		appUtilsSource.includes("text.slice(0, cursor)"),
		false,
		"detectTrigger must not call text.slice(0, cursor)",
	);
	assert.ok(
		appUtilsSource.includes("Math.max(0, cursor - MAX_TRIGGER_LOOKBACK)"),
		"detectTrigger must constrain slice window using MAX_TRIGGER_LOOKBACK",
	);
});
