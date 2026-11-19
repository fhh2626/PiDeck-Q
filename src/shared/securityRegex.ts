import { RegExpValidator } from "@eslint-community/regexpp";

// Node 22 and 24's V8 engines reject the 32768th capturing group.
const MAX_CAPTURE_GROUPS = 32767;

/**
 * Validate the common syntax accepted by the renderer and native policy writer.
 * regexpp stays pinned to 4.12.1 because its Unicode 16 identifier data matches
 * Node 22.19. Version 4.12.2 changes those tables to Unicode 17 even when parsing
 * ECMAScript 2024, accepting group names that make Node 22 reject the snapshot.
 */
export function isValidSecurityPattern(source: string): boolean {
	let captureGroups = 0;
	try {
		new RegExpValidator({
			ecmaVersion: 2024,
			// Named groups cause a second parser pass. Count each pass separately.
			onPatternEnter() { captureGroups = 0; },
			onCapturingGroupEnter() {
				captureGroups += 1;
				if (captureGroups > MAX_CAPTURE_GROUPS) {
					throw new Error("Security pattern exceeds the runtime capture limit");
				}
			},
		}).validatePattern(source);
		return true;
	} catch {
		return false;
	}
}
