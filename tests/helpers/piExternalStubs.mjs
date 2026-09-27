/**
 * Test doubles for the external packages the pi-subagents extension imports.
 *
 * This checkout does not vendor the extension's npm dependencies (typebox, yaml,
 * @earendil-works/*), so the graph loader redirects those bare specifiers here.
 * Only module-load-time shape is required: none of the test paths render TUI
 * output, parse YAML, or construct provider clients. Anything that unexpectedly
 * depends on real behavior will fail loudly through assertDoubleUnused().
 */

function unused(name) {
	return (...args) => {
		throw new Error(`External stub '${name}' was invoked during tests; this path needs a real or explicitly stubbed implementation.`);
	};
}

/** typebox Type builder: schema construction happens at module load in a few
 *  modules; the tests never validate against these schemas. */
export const Type = new Proxy({}, {
	get: (_target, prop) => {
		if (prop === Symbol.toPrimitive || prop === "toString") return () => "[Type stub]";
		return () => ({ __typeboxStub: String(prop) });
	},
});

export class Compile {
	constructor() {
		throw new Error("External stub 'Compile' was constructed during tests.");
	}
}

export function parseYaml() { return unused("parseYaml")(); }
export function stringifyYaml() { return unused("stringifyYaml")(); }
export const parse = parseYaml;
export const stringify = stringifyYaml;

export class Agent {
	constructor() {
		throw new Error("External stub 'Agent' was constructed during tests.");
	}
}

export class SessionManager {
	constructor() {
		throw new Error("External stub 'SessionManager' was constructed during tests.");
	}
}

export class Text {}
export class Box {}
export class Container {}
export class Spacer {}
export class Markdown {}
export class Input {}
export class DynamicBorder {}

export const Key = new Proxy({}, { get: (_target, prop) => `stub:${String(prop)}` });

export const convertToLlm = unused("convertToLlm");
export const createReadOnlyTools = unused("createReadOnlyTools");
export const getLanguageFromPath = unused("getLanguageFromPath");
export const highlightCode = unused("highlightCode");
export const getMarkdownTheme = unused("getMarkdownTheme");
export const keyText = unused("keyText");
export const keyHint = unused("keyHint");
export const rawKeyHint = unused("rawKeyHint");
export const isKeyRelease = () => false;
export const matchesKey = () => false;
export const fuzzyFilter = unused("fuzzyFilter");
export const truncateToWidth = (text) => String(text ?? "");
export const visibleWidth = (text) => String(text ?? "").length;
export const wrapTextWithAnsi = (text) => [String(text ?? "")];
export const completeSimple = unused("completeSimple");
export const streamSimple = unused("streamSimple");
