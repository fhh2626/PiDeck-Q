import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { Schema, Slice, Fragment } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";

function loadCodec() {
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
				if (id === "../chips") return { parseRichInputChips: () => [] };
				return {};
			},
		},
		{ filename: "plainTextCodec.ts" },
	);
	return codecModule.exports;
}

const { serializeComposerDoc } = loadCodec();

function loadInsert() {
	const source = readFileSync(
		"src/renderer/src/components/session/composer/tiptap/insertComposerPlainText.ts",
		"utf8",
	);
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: "insertComposerPlainText.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (id) => {
				if (id === "@tiptap/pm/model") return { Slice, Fragment };
				return {};
			},
		},
		{ filename: "insertComposerPlainText.ts" },
	);
	return module.exports;
}

const {
	composerPlainTextInsertSteps,
	composerPlainTextToNodes,
	composerPlainTextToSlice,
	insertComposerPlainText,
} = loadInsert();

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

function createMockView(initialDoc) {
	let state = EditorState.create({ doc: initialDoc, schema });
	let lastDispatchedTr = null;
	const view = {
		get state() {
			return state;
		},
		dispatch(tr) {
			lastDispatchedTr = tr;
			state = state.apply(tr);
		},
		getLastTr() {
			return lastDispatchedTr;
		},
	};
	return view;
}

function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("composerPlainTextInsertSteps keeps ampersands as text, not HTML entities", () => {
	assertJsonEqual(composerPlainTextInsertSteps("A & B &amp; C"), [
		{ type: "text", text: "A & B &amp; C" },
	]);
});

test("composerPlainTextInsertSteps normalizes Windows newlines into hardBreaks", () => {
	assertJsonEqual(composerPlainTextInsertSteps("a\r\nb\nc\r"), [
		{ type: "text", text: "a" },
		{ type: "hardBreak" },
		{ type: "text", text: "b" },
		{ type: "hardBreak" },
		{ type: "text", text: "c" },
		{ type: "hardBreak" },
	]);
});

test("P0: insertComposerPlainText single line text replaces selection and produces 1 step", () => {
	const initialDoc = schema.node("doc", null, [schema.node("paragraph", null, [])]);
	const view = createMockView(initialDoc);
	insertComposerPlainText(view, "Hello World");

	const tr = view.getLastTr();
	assert.equal(tr.steps.length, 1);
	assert.equal(serializeComposerDoc(view.state.doc), "Hello World");
	assert.equal(view.state.selection.from, 12);
});

test("P0: insertComposerPlainText two lines text", () => {
	const initialDoc = schema.node("doc", null, [schema.node("paragraph", null, [])]);
	const view = createMockView(initialDoc);
	insertComposerPlainText(view, "Line 1\nLine 2");

	const tr = view.getLastTr();
	assert.equal(tr.steps.length, 1);
	assert.equal(serializeComposerDoc(view.state.doc), "Line 1\nLine 2");
});

test("P0: insertComposerPlainText multiple consecutive empty lines", () => {
	const initialDoc = schema.node("doc", null, [schema.node("paragraph", null, [])]);
	const view = createMockView(initialDoc);
	const text = "A\n\n\nB";
	insertComposerPlainText(view, text);

	const tr = view.getLastTr();
	assert.equal(tr.steps.length, 1);
	assert.equal(serializeComposerDoc(view.state.doc), "A\n\n\nB");
});

test("P0: insertComposerPlainText Windows \\r\\n and \\r normalization", () => {
	const initialDoc = schema.node("doc", null, [schema.node("paragraph", null, [])]);
	const view = createMockView(initialDoc);
	insertComposerPlainText(view, "win\r\nmac\rold\nend");

	const tr = view.getLastTr();
	assert.equal(tr.steps.length, 1);
	assert.equal(serializeComposerDoc(view.state.doc), "win\nmac\nold\nend");
});

test("P0: insertComposerPlainText text with only newlines", () => {
	const initialDoc = schema.node("doc", null, [schema.node("paragraph", null, [])]);
	const view = createMockView(initialDoc);
	insertComposerPlainText(view, "\n\n\n");

	const tr = view.getLastTr();
	assert.equal(tr.steps.length, 1);
	assert.equal(serializeComposerDoc(view.state.doc), "\n\n\n");
});

test("P0: insertComposerPlainText replaces existing selection", () => {
	const initialDoc = schema.node("doc", null, [
		schema.node("paragraph", null, [schema.text("prefix TARGET suffix")]),
	]);
	const view = createMockView(initialDoc);
	// select "TARGET" (offset 8 to 14 in PM coords)
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 14)));

	insertComposerPlainText(view, "REPLACED\nLINE2");
	const tr = view.getLastTr();
	assert.equal(tr.steps.length, 1);
	assert.equal(serializeComposerDoc(view.state.doc), "prefix REPLACED\nLINE2 suffix");
});

test("P0: insertComposerPlainText 10000 lines insertion has steps.length === 1 and matches serialized output", () => {
	const initialDoc = schema.node("doc", null, [schema.node("paragraph", null, [])]);
	const view = createMockView(initialDoc);
	const lines = [];
	for (let i = 0; i < 10000; i++) {
		lines.push(`log record line #${i} [info] timestamp=${1000000 + i}`);
	}
	const fullText = lines.join("\n");

	insertComposerPlainText(view, fullText);
	const tr = view.getLastTr();
	assert.equal(tr.steps.length, 1, "Transaction step count must be 1 regardless of line count");
	assert.equal(serializeComposerDoc(view.state.doc), fullText);
});
