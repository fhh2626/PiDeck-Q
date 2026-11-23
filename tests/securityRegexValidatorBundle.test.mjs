import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { buildSecurityRegexValidator } from "../scripts/bundle-security-regex-validator.mjs";

test("the embedded native regex validator matches its pinned source and portable syntax", async () => {
	const { bundle, header, headerPath } = await buildSecurityRegexValidator();
	assert.equal(await readFile(headerPath, "utf8"), header, "Regenerate the embedded validator after source or dependency changes");
	const context = createContext({});
	// Exercise the same missing standard-library method as Qt 6.11.
	runInContext("Object.fromEntries = undefined", context);
	runInContext(bundle, context);
	const validatePattern = runInContext("PiDeckSecurityRegex.validatePattern", context);
	const patterns = [
		String.raw`\u0061`, "(?<=prefix)foo", "(?<!prefix)foo", String.raw`(?<name>foo)\k<name>`,
		"[]", "[^]", "[", "(?i)Remove-Item",
		"(?|a|b)", "(?>foo)", "foo++", "(?R)", "[a-z]+", "",
	];
	for (const pattern of patterns) {
		let accepted = true;
		try { new RegExp(pattern); } catch { accepted = false; }
		assert.equal(validatePattern(pattern), accepted, pattern);
	}
	for (const pattern of ["(?i:foo)", "(?<name>foo)|(?<name>bar)"]) {
		assert.equal(validatePattern(pattern), false, `Node 22 Pi runtimes do not support ${pattern}`);
	}
});

test("the embedded validator keeps named groups within Node 22's Unicode 16 character set", async () => {
	const { bundle } = await buildSecurityRegexValidator();
	const context = createContext({});
	runInContext("Object.fromEntries = undefined", context);
	runInContext(bundle, context);
	const validatePattern = runInContext("PiDeckSecurityRegex.validatePattern", context);
	const unicode16Letter = String.fromCodePoint(0x105c0);
	const unicode17Letter = String.fromCodePoint(0x11db0);
	const patterns = [
		[String.raw`(?<\u{105C0}>a)\k<\uD801\uDDC0>`, true],
		[`(?<${unicode16Letter}>a)\\k<${unicode16Letter}>`, true],
		[String.raw`(?<\uD801\uDDC0>a)\k<\u{105C0}>`, true],
		[String.raw`(?<$name_0\u0301\u200C\u200D>a)`, true],
		[String.raw`(?<_name>a)`, true],
		[String.raw`(?<名>a)\k<名>`, true],
		[`(?<name>${unicode17Letter})`, true], // Only group names are restricted.
		[String.raw`(?<\u{11DB0}>a)`, false],
		[`(?<${unicode17Letter}>a)`, false],
		[String.raw`(?<a\u{11DB0}>a)`, false],
		[String.raw`(?<\uD807\uDDB0>a)\k<\u{11DB0}>`, false],
		[String.raw`(?<a\u{1ACF}>a)`, false], // A character added only to ID_Continue in Unicode 17.
		[String.raw`(?<a\u0301>a)`, true],
		[String.raw`(?<\u0301name>a)`, false],
		[String.raw`(?<\u200Cname>a)`, false],
	];
	for (const [pattern, accepted] of patterns) {
		assert.equal(validatePattern(pattern), accepted, pattern);
		if (process.versions.node.startsWith("22.")) {
			for (const flags of ["", "i"]) {
				if (accepted) assert.doesNotThrow(() => new RegExp(pattern, flags), pattern);
				else assert.throws(() => new RegExp(pattern, flags), SyntaxError, pattern);
			}
		}
	}
});

test("the embedded validator respects the V8 capture limit without counting noncapturing groups", async () => {
	const { bundle } = await buildSecurityRegexValidator();
	const context = createContext({});
	runInContext(bundle, context);
	const validatePattern = runInContext("PiDeckSecurityRegex.validatePattern", context);
	assert.equal(validatePattern("()".repeat(32767)), true);
	assert.equal(validatePattern("()".repeat(32768)), false, "V8 refuses more than 32767 capturing groups");
	assert.equal(validatePattern("(?:)".repeat(32768)), true);
	assert.equal(validatePattern("()".repeat(32766) + "(?<name>)"), true);
	assert.equal(validatePattern("()".repeat(32767) + "(?<name>)"), false);
});
