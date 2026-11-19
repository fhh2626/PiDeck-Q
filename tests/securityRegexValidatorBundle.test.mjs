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
