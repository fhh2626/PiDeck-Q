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
	// Unicode 16 names remain valid, including escaped and astral characters.
	for (const pattern of [String.raw`(?<\u{105C0}>a)`, `(?<${String.fromCodePoint(0x105c0)}>a)`, String.raw`(?<名>a)\k<名>`]) {
		assert.equal(validatePattern(pattern), true, pattern);
	}
	// regexpp 4.12.2 accepts these Unicode 17 names even with ecmaVersion 2024.
	for (const pattern of [String.raw`(?<\u{11DB0}>a)`, `(?<${String.fromCodePoint(0x11db0)}>a)`, String.raw`(?<a\u{11DB0}>a)`]) {
		assert.equal(validatePattern(pattern), false, "the published policy must also compile on Node 22");
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
