import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { Schema } from "@tiptap/pm/model";

function loadCodec() {
	const chipsSource = readFileSync(
		"src/renderer/src/components/session/composer/chips.ts",
		"utf8",
	);
	const chipsOut = ts.transpileModule(chipsSource, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: "chips.ts",
	}).outputText;
	const chipsModule = { exports: {} };
	vm.runInNewContext(
		chipsOut,
		{ module: chipsModule, exports: chipsModule.exports, require: () => ({}), console, Set },
		{ filename: "chips.ts" },
	);

	const codecSource = readFileSync(
		"src/renderer/src/components/session/composer/tiptap/plainTextCodec.ts",
		"utf8",
	);
	const codecOut = ts.transpileModule(codecSource, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: "plainTextCodec.ts",
	}).outputText;
	const codecModule = { exports: {} };
	vm.runInNewContext(
		codecOut,
		{
			module: codecModule,
			exports: codecModule.exports,
			require: (id) => {
				if (id === "../chips") return chipsModule.exports;
				return {};
			},
			console,
			Set,
		},
		{ filename: "plainTextCodec.ts" },
	);
	return codecModule.exports;
}

const {
	plainTextToComposerDoc,
	composerDocToPlainText,
	serializeComposerDoc,
	serializeComposerEditorJson,
} = loadCodec();

const schema = new Schema({
	nodes: {
		doc: { content: "paragraph+" },
		paragraph: { content: "inline*" },
		text: { group: "inline" },
		hardBreak: { group: "inline", inline: true, selectable: false },
		mentionChip: {
			group: "inline",
			inline: true,
			attrs: { kind: { default: "file" }, raw: { default: "" }, label: { default: "" } },
		},
	},
});

test("plainText codec roundtrips empty, multiline, and trailing newline", () => {
	for (const sample of ["", "hello", "a\nb", "a\n\nb", "line\n"]) {
		const doc = plainTextToComposerDoc(sample);
		assert.equal(composerDocToPlainText(doc), sample);
	}
});

test("plainText codec roundtrips mention chips with whitelist", () => {
	const text = "看 @src/a.ts 与 /compact 和 &alpha 结束";
	const doc = plainTextToComposerDoc(text, {
		validCommandNames: new Set(["compact"]),
		validFilePaths: new Set(["src/a.ts"]),
		validSessionRefs: new Set(["alpha"]),
	});
	assert.equal(composerDocToPlainText(doc), text);
	const kinds = [];
	const walk = (node) => {
		if (node.type === "mentionChip") kinds.push(node.attrs.kind);
		node.content?.forEach(walk);
	};
	walk(doc);
	assert.deepEqual(kinds, ["file", "skill", "session"]);
});

test("plainText codec does not create session chip for && when whitelisted", () => {
	const doc = plainTextToComposerDoc("run && echo", {
		validSessionRefs: new Set(["alpha"]),
	});
	assert.equal(composerDocToPlainText(doc), "run && echo");
	let mentions = 0;
	const walk = (node) => {
		if (node.type === "mentionChip") mentions += 1;
		node.content?.forEach(walk);
	};
	walk(doc);
	assert.equal(mentions, 0);
});

test("P1: serializeComposerDoc matches composerDocToPlainText for empty document", () => {
	const pmDoc = schema.node("doc", null, [schema.node("paragraph", null, [])]);
	const jsonDoc = pmDoc.toJSON();
	assert.equal(serializeComposerDoc(pmDoc), "");
	assert.equal(composerDocToPlainText(jsonDoc), "");
	assert.equal(serializeComposerDoc(pmDoc), composerDocToPlainText(jsonDoc));
});

test("P1: serializeComposerDoc matches composerDocToPlainText for plain text", () => {
	const pmDoc = schema.node("doc", null, [
		schema.node("paragraph", null, [schema.text("Hello world")]),
	]);
	const jsonDoc = pmDoc.toJSON();
	assert.equal(serializeComposerDoc(pmDoc), "Hello world");
	assert.equal(serializeComposerDoc(pmDoc), composerDocToPlainText(jsonDoc));
});

test("P1: serializeComposerDoc matches composerDocToPlainText for multiline hardBreak", () => {
	const pmDoc = schema.node("doc", null, [
		schema.node("paragraph", null, [
			schema.text("Line 1"),
			schema.nodes.hardBreak.create(),
			schema.nodes.hardBreak.create(),
			schema.text("Line 3"),
			schema.nodes.hardBreak.create(),
		]),
	]);
	const jsonDoc = pmDoc.toJSON();
	assert.equal(serializeComposerDoc(pmDoc), "Line 1\n\nLine 3\n");
	assert.equal(serializeComposerDoc(pmDoc), composerDocToPlainText(jsonDoc));
});

test("P1: serializeComposerDoc matches composerDocToPlainText for mentionChip", () => {
	const pmDoc = schema.node("doc", null, [
		schema.node("paragraph", null, [
			schema.node("mentionChip", { kind: "file", raw: "@src/test.ts", label: "test.ts" }),
			schema.text(" "),
			schema.node("mentionChip", { kind: "skill", raw: "/help", label: "help" }),
			schema.text(" "),
			schema.node("mentionChip", { kind: "session", raw: "&session-1", label: "session-1" }),
		]),
	]);
	const jsonDoc = pmDoc.toJSON();
	assert.equal(serializeComposerDoc(pmDoc), "@src/test.ts /help &session-1");
	assert.equal(serializeComposerDoc(pmDoc), composerDocToPlainText(jsonDoc));
});

test("P1: serializeComposerDoc matches composerDocToPlainText for mixed text + chip + hardBreak", () => {
	const pmDoc = schema.node("doc", null, [
		schema.node("paragraph", null, [
			schema.text("Check "),
			schema.node("mentionChip", { kind: "file", raw: "@README.md", label: "README.md" }),
			schema.text(" and run"),
			schema.nodes.hardBreak.create(),
			schema.node("mentionChip", { kind: "skill", raw: "/compact", label: "compact" }),
			schema.nodes.hardBreak.create(),
			schema.text("Done."),
		]),
	]);
	const jsonDoc = pmDoc.toJSON();
	const expected = "Check @README.md and run\n/compact\nDone.";
	assert.equal(serializeComposerDoc(pmDoc), expected);
	assert.equal(serializeComposerDoc(pmDoc), composerDocToPlainText(jsonDoc));
	assert.equal(serializeComposerEditorJson(jsonDoc), expected);
});

test("P1: useTipTapComposerEditor hot path does not call editor.getJSON()", () => {
	const editorSource = readFileSync(
		"src/renderer/src/components/session/composer/useTipTapComposerEditor.ts",
		"utf8",
	);
	assert.equal(
		editorSource.includes("getJSON"),
		false,
		"useTipTapComposerEditor must not call getJSON()",
	);
	assert.equal(
		editorSource.includes("serializeComposerDoc(editor.state.doc)"),
		true,
		"useTipTapComposerEditor must serialize directly from editor.state.doc",
	);
});
