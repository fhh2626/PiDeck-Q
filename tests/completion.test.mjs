import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function transpileModule(path, requireImpl = () => ({})) {
	const source = readFileSync(path, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: path,
	});
	const module = { exports: {} };
	vm.runInNewContext(
		outputText,
		{
			module,
			exports: module.exports,
			require: requireImpl,
			console,
		},
		{ filename: path },
	);
	return module.exports;
}

const chips = transpileModule(
	"src/renderer/src/components/session/composer/chips.ts",
);
const completion = transpileModule(
	"src/renderer/src/components/session/composer/completion.ts",
	(id) => id === "./chips" ? chips : {},
);
const {
	applyCompletion,
	canKeepCompletionAtCursor,
	canStartCompletion,
	isValidCompletionQuery,
	updateCompletion,
} = completion;

test("TipTap reports real text input but suppresses it during composition", () => {
	const editorProps = transpileModule(
		"src/renderer/src/components/session/composer/tiptap/buildComposerEditorProps.ts",
		(id) => {
			if (id === "./domEventBridge") {
				return { toComposerDomKeyboardEvent: (event) => event };
			}
			if (id === "./insertComposerPlainText") {
				return { insertComposerPlainText: () => undefined };
			}
			if (id === "../../../../utils/clipboard") {
				return { htmlToPlainText: (html) => html };
			}
			return {};
		},
	);
	const composingRef = { current: false };
	const inputs = [];
	const props = editorProps.buildComposerEditorProps(
		{ composingRef, onTextInput: (text) => inputs.push(text) },
		{},
	);
	props.handleTextInput({}, 0, 0, "@");
	composingRef.current = true;
	props.handleTextInput({}, 1, 1, "&");
	assert.deepEqual(inputs, ["@"]);
});

function session(overrides = {}) {
	return {
		id: 1,
		char: "@",
		start: 0,
		end: 1,
		query: "",
		dismissed: false,
		...overrides,
	};
}

function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("only valid real-input boundaries can start @, /, and & completion", () => {
	assert.equal(canStartCompletion("@", 0, "@"), true);
	assert.equal(canStartCompletion("hello @", 6, "@"), true);
	assert.equal(canStartCompletion("user@host", 4, "@"), false);
	assert.equal(canStartCompletion("C:/foo", 2, "/"), false);
	assert.equal(canStartCompletion("https://foo/bar", 6, "/"), false);
	assert.equal(canStartCompletion("src/foo", 3, "/"), false);
	assert.equal(canStartCompletion("hello /compact", 6, "/"), true);
	assert.equal(canStartCompletion("  /compact", 2, "/"), true);
	assert.equal(canStartCompletion("foo\n  /compact", 6, "/"), true);
	assert.equal(canStartCompletion("Tom &", 4, "&", new Set(["alpha"])), true);
	assert.equal(canStartCompletion("&", 0, "&", new Set()), false);
	assert.equal(canStartCompletion("cmd&x", 3, "&", new Set(["x"])), false);
	assert.equal(canStartCompletion("https://example.test/?x=&", 24, "&", new Set(["alpha"])), false);
});

test("completion query rules distinguish plain @ text, paths, commands, and sessions", () => {
	const refs = new Set(["alpha", "beta long"]);
	assert.equal(isValidCompletionQuery("/", "compact"), true);
	assert.equal(isValidCompletionQuery("/", "中文_2:-"), true);
	assert.equal(isValidCompletionQuery("/", "compact/next"), false);
	assert.equal(isValidCompletionQuery("@", "foo"), true);
	assert.equal(isValidCompletionQuery("@", "foo bar"), false);
	assert.equal(isValidCompletionQuery("@", "C:\\foo bar"), true);
	assert.equal(isValidCompletionQuery("@", "/Users/foo bar"), true);
	assert.equal(isValidCompletionQuery("@", '"foo bar.txt"'), true);
	assert.equal(isValidCompletionQuery("@", '"C:/Program Files/app.exe"'), true);
	assert.equal(isValidCompletionQuery("@", "foo\nbar"), false);
	assert.equal(isValidCompletionQuery("&", "al", refs), true);
	assert.equal(isValidCompletionQuery("&", "beta l", refs), true);
	assert.equal(isValidCompletionQuery("&", "C:/Users/me", new Set(["C:/Users/me/session.json"])), true);
	assert.equal(isValidCompletionQuery("&", "ghost", refs), false);
	assert.equal(isValidCompletionQuery("&", "alpha/", refs), false);
});

test("updating a session follows its own range and keeps dismissed state dismissed", () => {
	const active = session();
	assertJsonEqual(updateCompletion(active, "@", 1), session());
	assertJsonEqual(updateCompletion(active, "@abc", 4), {
		...session(),
		end: 4,
		query: "abc",
	});
	assert.equal(updateCompletion(active, "x@abc", 5), null);
	assertJsonEqual(updateCompletion({ ...active, end: 4, query: "abc" }, "@abc", 2), {
		...active,
		end: 2,
		query: "a",
	});
	assert.equal(canKeepCompletionAtCursor({ ...active, end: 4, query: "abc" }, "@abc", 2), false);

	const absolutePath = session({ end: 1 });
	const pathText = "@C:/Program Files";
	const pathSession = updateCompletion(absolutePath, pathText, pathText.length);
	assertJsonEqual(pathSession, {
		...absolutePath,
		end: pathText.length,
		query: "C:/Program Files",
	});
	assertJsonEqual(applyCompletion(pathText, pathSession, '@"C:/Program Files"'), {
		text: '@"C:/Program Files" ',
		cursor: '@"C:/Program Files" '.length,
	});
	const pathWithFollowingText = "@C:/Program Files please inspect";
	const pathWithFollowingTextSession = updateCompletion(
		absolutePath,
		pathWithFollowingText,
		pathWithFollowingText.length,
	);
	assert.equal(pathWithFollowingTextSession.query, "C:/Program Files please inspect");
	assert.equal(
		canKeepCompletionAtCursor(
			pathWithFollowingTextSession,
			pathWithFollowingText,
			pathWithFollowingText.length,
		),
		true,
	);

	const quotedPath = updateCompletion(
		absolutePath,
		'@"C:/Program Files/app.exe"',
		"@\"C:/Program Files/app.exe\"".length,
	);
	assert.equal(quotedPath.query, '"C:/Program Files/app.exe"');
	assertJsonEqual(applyCompletion('@"C:/Program Files/app.exe"', quotedPath, '@"C:/other file.exe"'), {
		text: '@"C:/other file.exe" ',
		cursor: '@"C:/other file.exe" '.length,
	});

	const dismissed = { ...session({ end: 4, query: "abc" }), dismissed: true };
	const stillDismissed = updateCompletion(dismissed, "@abcd", 5);
	assert.equal(stillDismissed.dismissed, true);
	assert.equal(stillDismissed.query, "abcd");
});

test("document edits can shrink a completion session after Backspace", () => {
	const at = session({ end: 5, query: "srcx" });
	assertJsonEqual(updateCompletion(at, "@src", "@src".length), {
		...at,
		end: 4,
		query: "src",
	});

	const slash = session({ char: "/", start: 3, end: 9, query: "compa" });
	assertJsonEqual(updateCompletion(slash, "go /comp", "go /comp".length), {
		...slash,
		end: 8,
		query: "comp",
	});

	const amp = session({ char: "&", start: 3, end: 12, query: "sessionx" });
	assertJsonEqual(updateCompletion(amp, "go &session", "go &session".length, new Set(["sessionx"])), {
		...amp,
		end: 11,
		query: "session",
	});
});

test("Esc/X dismissal changes only lifecycle state, never text", () => {
	const dismissed = { ...session({ end: 4, query: "abc" }), dismissed: true };
	assert.equal(applyCompletion("@abc", dismissed, "@src/a"), null);
	assert.equal("@abc", "@abc");
});

test("applyCompletion replaces only the creating session range and rejects stale content", () => {
	const active = session({ start: 6, end: 10, query: "foo" });
	assertJsonEqual(applyCompletion("hello @foo world", active, "@src/a"), {
		text: "hello @src/a world",
		cursor: 12,
	});
	assertJsonEqual(applyCompletion("hello @foo-world", active, "@src/a"), {
		text: "hello @src/a -world",
		cursor: 13,
	});
	assert.equal(applyCompletion("hello @bar world", active, "@src/a"), null);
	assert.equal(applyCompletion("hello world", active, "@src/a"), null);
});

test("ordinary pasted absolute path is not a new completion trigger", () => {
	const pasted = "C:\\foo\\bar";
	assert.equal(updateCompletion(null, pasted, pasted.length), null);
	assert.equal(updateCompletion(null, "hello @ C:\\foo", 15), null);
});

test("@ followed by ordinary pasted path can continue typing and commit", () => {
	const first = session();
	const pasted = "@C:\\foo\\ba";
	const afterPaste = updateCompletion(first, pasted, pasted.length);
	assert.equal(afterPaste.query, "C:\\foo\\ba");

	const continued = `${pasted}r.txt`;
	const afterTyping = updateCompletion(afterPaste, continued, continued.length);
	assert.equal(afterTyping.query, "C:\\foo\\bar.txt");
	assertJsonEqual(applyCompletion(continued, afterTyping, "@C:\\foo\\bar.txt"), {
		text: "@C:\\foo\\bar.txt ",
		cursor: continued.length + 1,
	});
});

test("absolute @ paths expose a raw-path candidate before scanned files", () => {
	const appUtils = transpileModule(
		"src/renderer/src/components/app/AppUtils.ts",
		(id) => {
			if (id === "../session/composer/chips") return chips;
			if (id === "../../i18n") return { t: () => "Reference this path" };
			return {};
		},
	);
	const items = appUtils.buildCompletionSuggestionItems(
		{
			id: 2,
			char: "@",
			start: 0,
			end: 13,
			query: "C:\\foo\\part",
			dismissed: false,
		},
		[],
		[
			{
				path: "src/main.ts",
				name: "main.ts",
				relativePath: "src/main.ts",
				type: "file",
			},
		],
		[],
	);
	assert.equal(items[0].key, "raw-path:C:\\foo\\part");
	assert.equal(items[0].value, "@C:\\foo\\part");

	const spacedItems = appUtils.buildCompletionSuggestionItems(
		{
			id: 5,
			char: "@",
			start: 0,
			end: "@C:\\Program Files".length,
			query: "C:\\Program Files",
			dismissed: false,
		},
		[],
		[],
		[],
	);
	assert.equal(spacedItems[0].key, "raw-path:C:\\Program Files");
	assert.equal(spacedItems[0].value, '@"C:\\Program Files"');

	const quotedItems = appUtils.buildCompletionSuggestionItems(
		{
			id: 3,
			char: "@",
			start: 0,
			end: 25,
			query: '"C:/Program Files/app.exe"',
			dismissed: false,
		},
		[],
		[],
		[],
	);
	assert.equal(quotedItems[0].key, "raw-path:C:/Program Files/app.exe");
	assert.equal(quotedItems[0].value, '@"C:/Program Files/app.exe"');

	const sessionItems = appUtils.buildCompletionSuggestionItems(
		{
			id: 4,
			char: "&",
			start: 0,
			end: 12,
			query: "C:/Users/me",
			dismissed: false,
		},
		[],
		[],
		[
			{
				id: "session-1",
				filePath: "C:/Users/me/session.json",
				projectPath: "C:/Users/me",
				preview: "",
				updatedAt: 1,
			},
		],
	);
	assert.equal(sessionItems[0].value, "&C:/Users/me/session.json");
});

test("Enter remains outside completion commit while Tab is the completion key", () => {
	const controller = readFileSync(
		"src/renderer/src/hooks/useSessionComposerController.ts",
		"utf8",
	);
	assert.match(controller, /event\.key === "Tab"/);
	assert.doesNotMatch(controller, /suggestionsOpen[\s\S]{0,120}event\.key === "Enter"/);
	assert.match(controller, /getComposerEnterIntent\(event, sendShortcut\)/);
});

test("completion session state is cleared on reset and focus does not rescan text", () => {
	const controller = readFileSync(
		"src/renderer/src/hooks/useSessionComposerController.ts",
		"utf8",
	);
	assert.doesNotMatch(controller, /setSuggestionsOpen/);
	assert.doesNotMatch(controller, /detectTrigger/);
	assert.match(controller, /clearCompletion\(\);/);
	assert.match(controller, /onFocus: undefined/);
	assert.match(controller, /onBlur: dismissCompletion/);
});
