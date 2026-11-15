/**
 * Oracle reader for the embedded LAN web client.
 *
 * `WebServiceManager.renderPage()` returns one TS template literal. The C++ backend
 * has to serve that *same* document, so the tests need the oracle's emitted bytes
 * without importing the TypeScript module (it pulls in the whole main process). This
 * helper reads the source, finds the `return \`…\`` literal inside `renderPage()`,
 * decodes TS template-literal escapes exactly like the runtime would, and returns the
 * parts around the single `${…}` interpolation (the client dictionaries).
 *
 * The returned strings are the text a browser would receive — including the
 * `\\n`/`\\{` sequences that the TypeScript source has to double-escape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_SOURCE = "src/main/web/WebServiceManager.ts";
const COPY_SOURCE = "src/main/web/WebI18n.ts";

/** TS template-literal escape decoding (`\n`, `\t`, `\\`, `\``, `\$`, `\xNN`, `\uNNNN`). */
function decodeTemplateText(raw) {
	let out = "";
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (char !== "\\") {
			out += char;
			continue;
		}
		const next = raw[index + 1];
		index += 1;
		if (next === "n") out += "\n";
		else if (next === "t") out += "\t";
		else if (next === "r") out += "\r";
		else if (next === "\\") out += "\\";
		else if (next === "`") out += "`";
		else if (next === "$") out += "$";
		else if (next === "0") out += "\0";
		else if (next === "x") {
			out += String.fromCharCode(Number.parseInt(raw.slice(index + 1, index + 3), 16));
			index += 2;
		} else if (next === "u") {
			if (raw[index + 1] === "{") {
				const end = raw.indexOf("}", index);
				out += String.fromCodePoint(Number.parseInt(raw.slice(index + 2, end), 16));
				index = end;
			} else {
				out += String.fromCharCode(Number.parseInt(raw.slice(index + 1, index + 5), 16));
				index += 4;
			}
		} else {
			out += next;
		}
	}
	return out;
}

/**
 * Split the `renderPage()` template literal into the text around its interpolations.
 *
 * @returns {{ prefix: string, suffix: string, interpolations: string[] }}
 *   `prefix` ends with `const dictionaries = `, `suffix` starts with the `;` that
 *   terminates that statement.
 */
export function oracleLegacyPage({ repoRoot = process.cwd() } = {}) {
	const source = readFileSync(join(repoRoot, PAGE_SOURCE), "utf8");
	const methodStart = source.indexOf("private renderPage() {");
	if (methodStart < 0) throw new Error("renderPage() not found in WebServiceManager.ts");
	const literalStart = source.indexOf("return `", methodStart);
	if (literalStart < 0) throw new Error("renderPage() has no template literal");
	let index = literalStart + "return `".length;

	const parts = [];
	const interpolations = [];
	let text = "";
	while (index < source.length) {
		const char = source[index];
		if (char === "\\") {
			text += source.slice(index, index + 2);
			index += 2;
			continue;
		}
		if (char === "`") break;
		if (char === "$" && source[index + 1] === "{") {
			parts.push(decodeTemplateText(text));
			text = "";
			let depth = 1;
			let cursor = index + 2;
			while (cursor < source.length) {
				if (source[cursor] === "{") depth += 1;
				else if (source[cursor] === "}") {
					depth -= 1;
					if (depth === 0) break;
				}
				cursor += 1;
			}
			interpolations.push(source.slice(index + 2, cursor));
			parts.push(null); // placeholder for the interpolation
			index = cursor + 1;
			continue;
		}
		text += char;
		index += 1;
	}
	parts.push(decodeTemplateText(text));

	if (interpolations.length !== 1) {
		throw new Error(
			`expected exactly one interpolation in renderPage(), found ${interpolations.length}`,
		);
	}
	// parts = [text, <interpolation>, text]
	return { prefix: parts[0], suffix: parts[2], interpolations };
}

/** Every `"key": "value"` pair of one `export const … = { … }` block. */
function objectBlock(source, marker) {
	const start = source.indexOf(marker);
	if (start < 0) throw new Error(`${marker} not found in ${COPY_SOURCE}`);
	// The declaration may carry a type annotation before the initializer.
	const bodyStart = source.indexOf("= {", start);
	if (bodyStart < 0) throw new Error(`${marker} has no object initializer`);
	// `webZhCN` ends with `} as const;`, `webEnUS` with `};` — take whichever comes first.
	const ends = ["\n} as const;", "\n};"].map((needle) => source.indexOf(needle, bodyStart));
	const valid = ends.filter((index) => index >= 0);
	if (valid.length === 0) throw new Error(`${marker} block is not terminated`);
	return source.slice(bodyStart, Math.min(...valid));
}

/**
 * The `web.*` / `webError.*` copy the client dictionary must carry, per locale.
 *
 * Parsed from `WebI18n.ts` so the assertion covers every key instead of a sample;
 * values are JSON-decoded from their TS string literal (the tables only use plain
 * double-quoted strings, so the literal is valid JSON).
 */
export function oracleWebClientCopy({ repoRoot = process.cwd() } = {}) {
	const source = readFileSync(join(repoRoot, COPY_SOURCE), "utf8");
	const read = (marker) => {
		const block = objectBlock(source, marker);
		const table = {};
		for (const match of block.matchAll(/"([^"\\]+)":\s*("(?:[^"\\]|\\.)*")/g)) {
			const [, key, literal] = match;
			if (!key.startsWith("web")) continue;
			table[key] = JSON.parse(literal);
		}
		return table;
	};
	return { "zh-CN": read("export const webZhCN"), "en-US": read("export const webEnUS") };
}
