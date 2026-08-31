import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/** vm 跨 realm 时 deepEqual 会因原型不同误报，统一 JSON 比较。 */
function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function loadChips() {
	const source = readFileSync(
		"src/renderer/src/components/session/composer/chips.ts",
		"utf8",
	);
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "chips.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{ module, exports: module.exports, require: () => ({}), console, Set },
		{ filename: "chips.ts" },
	);
	return module.exports;
}

const {
	parseRichInputChips,
	formatFilePathRef,
	unwrapFileChipPath,
	extractPastedPath,
} = loadChips();

test("formatFilePathRef quotes spaced paths and marks directories", () => {
	assert.equal(formatFilePathRef("src/a.ts"), "@src/a.ts");
	assert.equal(formatFilePathRef("src/components", { isDirectory: true }), "@src/components/");
	assert.equal(formatFilePathRef("my docs/a.ts"), '@"my docs/a.ts"');
});

test("unwrapFileChipPath strips @ quotes and trailing separators", () => {
	assert.equal(unwrapFileChipPath("@src/a.ts"), "src/a.ts");
	assert.equal(unwrapFileChipPath("@src/"), "src");
	assert.equal(unwrapFileChipPath('@"my docs/"'), "my docs");
});

test("parseRichInputChips respects file and command whitelists", () => {
	const files = new Set(["src/a.ts"]);
	const cmds = new Set(["compact"]);
	const chips = parseRichInputChips(
		"看 @src/a.ts 和 @src/b.ts 再 /compact /unknown",
		cmds,
		files,
	);
	assertJsonEqual(
		chips.map((c) => ({ kind: c.kind, raw: c.raw })),
		[
			{ kind: "file", raw: "@src/a.ts" },
			{ kind: "skill", raw: "/compact" },
		],
	);
});

test("session chip with whitelist Set only matches known names", () => {
	const sessions = new Set(["alpha", "beta long"]);
	const chips = parseRichInputChips(
		"参考 &alpha 和 &beta long 还有 &ghost 以及 && cmd&x",
		undefined,
		undefined,
		sessions,
	);
	assertJsonEqual(
		chips.map((c) => c.raw),
		["&alpha", "&beta long"],
	);
});

test("known session names do not turn embedded ampersands into chips", () => {
	const sessions = new Set(["alpha"]);
	assertJsonEqual(
		parseRichInputChips("cmd&alpha && &alpha", undefined, undefined, sessions)
			.map((chip) => chip.raw),
		["&alpha"],
	);
	assertJsonEqual(
		parseRichInputChips("CMD&ALPHA", undefined, undefined, sessions)
			.map((chip) => chip.raw),
		[],
	);
	assertJsonEqual(
		parseRichInputChips("https://example.test/?x=&alpha", undefined, undefined, sessions)
			.map((chip) => chip.raw),
		[],
	);
});

test("session chip with empty whitelist creates no session chips", () => {
	const chips = parseRichInputChips("&& &oops cmd&x", undefined, undefined, new Set());
	assert.equal(chips.filter((c) => c.kind === "session").length, 0);
});

test("session chip without whitelist falls back to first word for timeline display", () => {
	const chips = parseRichInputChips("see &alpha next");
	assertJsonEqual(
		chips.filter((c) => c.kind === "session").map((c) => c.raw),
		["&alpha"],
	);
});

test("URL path segments are not parsed as chips", () => {
	const chips = parseRichInputChips(
		"https://example.com/foo @src/a.ts",
		undefined,
		new Set(["src/a.ts"]),
	);
	assertJsonEqual(
		chips.map((c) => c.raw),
		["@src/a.ts"],
	);
});

test("session references may use absolute file paths", () => {
	const ref = "C:/Users/me/.pi/session file.json";
	const chips = parseRichInputChips(`open &${ref}`, undefined, undefined, new Set([ref]));
	assertJsonEqual(chips.map((chip) => chip.raw), [`&${ref}`]);
});

test("unquoted absolute path with spaces is extended into one file chip", () => {
	const chips = parseRichInputChips(
		"@C:/Users/528/Documents/Tencent Files/473812916/nt_qq/nt_data/Pic/2026-08/Ori/455f949b57b937a5491cbb0a6f7bd07a.png",
	);
	assertJsonEqual(
		chips.map((c) => ({ kind: c.kind, raw: c.raw, label: c.label })),
		[
			{
				kind: "file",
				raw: '@"C:/Users/528/Documents/Tencent Files/473812916/nt_qq/nt_data/Pic/2026-08/Ori/455f949b57b937a5491cbb0a6f7bd07a.png"',
				label: "C:/Users/528/Documents/Tencent Files/473812916/nt_qq/nt_data/Pic/2026-08/Ori/455f949b57b937a5491cbb0a6f7bd07a.png",
			},
		],
	);
});

test("unquoted spaced absolute path stops before following text and URLs", () => {
	const withText = parseRichInputChips("@C:/Program Files/nodejs 帮我看看");
	assertJsonEqual(
		withText.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: '@"C:/Program Files/nodejs"', label: "C:/Program Files/nodejs" }],
	);
	// 延伸不跨过 URL：https:// 是正文，不是路径的一部分
	const withUrl = parseRichInputChips("@C:/foo https://x.com/a");
	assertJsonEqual(
		withUrl.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@C:/foo", label: "C:/foo" }],
	);
	const pathThenCommand = parseRichInputChips("@C:/foo /compact", new Set(["compact"]));
	assertJsonEqual(
		pathThenCommand.map((c) => ({ raw: c.raw, kind: c.kind })),
		[
			{ raw: "@C:/foo", kind: "file" },
			{ raw: "/compact", kind: "skill" },
		],
	);
});

test("unquoted spaced absolute path supports backslashes and dir suffix", () => {
	const backslash = parseRichInputChips("@C:\\Users\\Tencent Files\\a.png");
	assertJsonEqual(
		backslash.map((c) => ({ raw: c.raw, label: c.label })),
		[
			{
				raw: '@"C:\\Users\\Tencent Files\\a.png"',
				label: "C:/Users/Tencent Files/a.png",
			},
		],
	);
	const dir = parseRichInputChips("@C:/Program Files/");
	assertJsonEqual(
		dir.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: '@"C:/Program Files/"', label: "C:/Program Files/" }],
	);
});

test("POSIX absolute path with spaces is extended", () => {
	const chips = parseRichInputChips("@/Users/me/My Documents/a.txt");
	assertJsonEqual(
		chips.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: '@"/Users/me/My Documents/a.txt"', label: "/Users/me/My Documents/a.txt" }],
	);
});

test("space-free absolute path keeps raw unquoted", () => {
	const chips = parseRichInputChips("@C:/foo/bar.txt");
	assertJsonEqual(
		chips.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@C:/foo/bar.txt", label: "C:/foo/bar.txt" }],
	);
});

test("extractPastedPath recognizes single absolute path pastes", () => {
	assert.equal(
		extractPastedPath("C:/Users/528/Documents/Tencent Files/455f949b57b937a5491cbb0a6f7bd07a.png"),
		"C:/Users/528/Documents/Tencent Files/455f949b57b937a5491cbb0a6f7bd07a.png",
	);
	assert.equal(extractPastedPath("@C:/Users/x.png"), "C:/Users/x.png");
	assert.equal(extractPastedPath('"C:\\Users\\Tencent Files\\x.png"'), "C:\\Users\\Tencent Files\\x.png");
	assert.equal(extractPastedPath('@"C:/a b.txt"'), "C:/a b.txt");
	assert.equal(extractPastedPath("/Users/me/a.txt"), "/Users/me/a.txt");
});

test("extractPastedPath rejects non-path text and relative paths", () => {
	assert.equal(extractPastedPath("看下 C:/foo.txt 这个文件"), null);
	assert.equal(extractPastedPath("src/foo bar/a.ts"), null);
	assert.equal(extractPastedPath("C:/foo.txt\nC:/bar.txt"), null);
	assert.equal(extractPastedPath(""), null);
	assert.equal(extractPastedPath("C:"), null);
});
