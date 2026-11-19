import "./polyfills.mjs";
import { RegExpValidator } from "@eslint-community/regexpp";

/** Validate the syntax used by the Node extension without compiling or running a command. */
export function validatePattern(source) {
	try {
		// Both shell tools use non-Unicode RegExp syntax. PowerShell's fixed `i`
		// flag changes matching only. Use the common ECMAScript 2024 baseline so
		// Pi runtimes on Node 22 can load the policy too.
		new RegExpValidator({ ecmaVersion: 2024 }).validatePattern(source);
		return true;
	} catch {
		return false;
	}
}
