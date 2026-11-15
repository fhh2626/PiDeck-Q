/**
 * Regenerate the C++ embedded copy of the LAN web client page.
 *
 * The oracle owns the page (`WebServiceManager.renderPage()`); the C++ backend serves
 * it byte-for-byte, so the three generated files must never be hand-edited:
 *
 *   native/backend/domain/web/WebLegacyDocument.{h,cpp}   head/styles/markup prefix
 *   native/backend/domain/web/WebLegacyScript.cpp         script + document tail
 *
 * Usage:
 *   node tests/fixtures/regen-legacy-web-page.mjs           # write the files
 *   node tests/fixtures/regen-legacy-web-page.mjs --check   # exit 1 when stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { oracleLegacyPage } from "../helpers/native2LegacyWebOracle.mjs";

const repoRoot = process.cwd();
const webDir = join(repoRoot, "native", "backend", "domain", "web");

const HEADER = `#pragma once

#include <QByteArray>

/**
 * Embedded LAN web client document (port of \`WebServiceManager.renderPage()\`).
 *
 * The oracle's page is one TS template literal with exactly one dynamic value: the
 * client dictionaries (\`const dictionaries = …\`). Both halves are carried here
 * *verbatim* (the emitted bytes, not the TypeScript source), so the served page can be
 * compared against the oracle template by a test instead of by eye:
 * \`tests/helpers/native2LegacyWebOracle.mjs\` decodes the same literal and
 * \`tests/native2LegacyWebClient.test.mjs\` asserts byte equality around the
 * dictionaries.
 *
 * Embedded rather than shipped as a file because this document is also the
 * *no-bundle* fallback: it must be servable when \`app/renderer/web.html\` is missing
 * from an install, so it cannot live in the bundle it is replacing.
 *
 * Generated — do not edit by hand. Regenerate from the oracle with:
 *
 *   node tests/fixtures/regen-legacy-web-page.mjs
 */
namespace weblegacy {

/** Head, styles, markup, \`<script>\` and the opening \`const dictionaries = \`. */
QByteArray documentPrefix();

/** From the \`;\` that ends the dictionaries statement to \`</html>\`. */
QByteArray documentSuffix();

} // namespace weblegacy
`;

/**
 * Emit the text as adjacent raw string literals.
 *
 * MSVC truncates a single string literal beyond 16 380 characters (C2026), and the
 * oracle page is larger than that, so the content is split on line boundaries (well
 * below the cap) and concatenated by the compiler. Splitting never lands inside a
 * multi-byte UTF-8 sequence because every chunk boundary is a `\n`.
 */
function cppLiteral(text, variableName) {
	const chunks = [];
	let current = "";
	for (const line of text.split("\n")) {
		const candidate = current === "" ? line : `${current}\n${line}`;
		if (current !== "" && Buffer.byteLength(candidate) > 4000) {
			chunks.push(current);
			// Keep the newline the candidate had: adjacent literals concatenate verbatim.
			current = `\n${line}`;
			continue;
		}
		current = candidate;
	}
	chunks.push(current);
	const literals = chunks.map((chunk) => `    R"PIDECKLEGACY(${chunk})PIDECKLEGACY"`);
	return `constexpr char ${variableName}[] =\n${literals.join("\n")};`;
}

const DOCUMENT_CPP = `#include "WebLegacyDocument.h"

namespace weblegacy {
namespace {

/**
 * Everything the browser receives before the dictionaries JSON.
 *
 * Kept as raw literals so no escape processing can drift from the oracle: the text
 * below is exactly what the TS template emits (tabs, \`\\n\`, \`\\{\` …).
 */
$PREFIX$;

} // namespace

QByteArray documentPrefix()
{
    return QByteArray(kPrefix, int(sizeof(kPrefix) - 1));
}

} // namespace weblegacy
`;

const SCRIPT_CPP = `#include "WebLegacyDocument.h"

namespace weblegacy {
namespace {

/**
 * The client script and the document tail, i.e. everything after the dictionaries
 * JSON. Verbatim for the same reason as \`kPrefix\` in WebLegacyDocument.cpp.
 */
$SUFFIX$;

} // namespace

QByteArray documentSuffix()
{
    return QByteArray(kSuffix, int(sizeof(kSuffix) - 1));
}

} // namespace weblegacy
`;

/** Fail instead of emitting a literal the C++ compiler would truncate or split. */
function assertEmbeddable(name, text) {
	if (text.includes(')PIDECKLEGACY"')) {
		throw new Error(`${name} contains the raw-string delimiter; pick another one`);
	}
	if (text.includes("\r")) throw new Error(`${name} contains CR; the oracle emits LF only`);
	if (text.includes("\0")) throw new Error(`${name} contains NUL`);
}

const { prefix, suffix } = oracleLegacyPage({ repoRoot });
assertEmbeddable("page prefix", prefix);
assertEmbeddable("page suffix", suffix);

const files = {
	"WebLegacyDocument.h": HEADER,
	"WebLegacyDocument.cpp": DOCUMENT_CPP.replace("$PREFIX$", () => cppLiteral(prefix, "kPrefix")),
	"WebLegacyScript.cpp": SCRIPT_CPP.replace("$SUFFIX$", () => cppLiteral(suffix, "kSuffix")),
};

const check = process.argv.includes("--check");
let stale = 0;
for (const [name, content] of Object.entries(files)) {
	const path = join(webDir, name);
	if (check) {
		let current = "";
		try {
			current = readFileSync(path, "utf8");
		} catch {
			current = "";
		}
		if (current !== content) {
			stale += 1;
			console.error(`${name} is stale; run node tests/fixtures/regen-legacy-web-page.mjs`);
		}
		continue;
	}
	writeFileSync(path, content);
	console.log(`wrote ${path} (${content.length} bytes)`);
}
if (check) {
	console.log(stale === 0 ? "embedded legacy page matches the oracle" : `${stale} file(s) stale`);
	process.exitCode = stale === 0 ? 0 : 1;
}
