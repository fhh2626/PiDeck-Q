import { RegExpValidator } from "@eslint-community/regexpp";
import { ID_CONTINUE_RANGES, ID_START_RANGES } from "./securityRegexUnicode16.ts";

// Node 22 and 24's V8 engines reject the 32768th capturing group.
const MAX_CAPTURE_GROUPS = 32767;

/** Decode the generated ranges into a flat array of inclusive start/end pairs. */
function decodeRanges(encoded: string): number[] {
	const pairs = encoded.split(" ");
	const ranges: number[] = [];
	let end = -1;
	for (let i = 0; i < pairs.length; i += 2) {
		const start = end + 1 + parseInt(pairs[i], 36);
		end = start + parseInt(pairs[i + 1], 36);
		ranges.push(start, end);
	}
	return ranges;
}

const unicode16Start = decodeRanges(ID_START_RANGES);
const unicode16Continue = decodeRanges(ID_CONTINUE_RANGES);

/** Search the sorted pairs without depending on the Qt or browser Unicode tables. */
function includesCodePoint(ranges: number[], point: number): boolean {
	let low = 0;
	let high = ranges.length / 2;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (point < ranges[mid * 2]) high = mid;
		else if (point > ranges[mid * 2 + 1]) low = mid + 1;
		else return true;
	}
	return false;
}

/** Check the decoded name against Node 22.19's Unicode 16 identifier grammar. */
function isPortableGroupName(name: string): boolean {
	let first = true;
	for (const character of name) {
		const point = character.codePointAt(0);
		if (point === undefined) return false;
		// ECMAScript permits $ and _ anywhere and the join controls after the first character.
		const isExtra = point === 0x24 || point === 0x5f || (!first && (point === 0x200c || point === 0x200d));
		if (!isExtra && !includesCodePoint(first ? unicode16Start : unicode16Continue, point)) return false;
		first = false;
	}
	return !first;
}

/**
 * Validate the common syntax accepted by the renderer and native policy writer.
 * regexpp can recognize newer Unicode names even in ECMAScript 2024 mode.
 * Pi compiles saved rules in its own runtime, so keep the Node 22 floor independent of regexpp.
 */
export function isValidSecurityPattern(source: string): boolean {
	let captureGroups = 0;
	try {
		new RegExpValidator({
			ecmaVersion: 2024,
			// Named groups cause a second parser pass. Count each pass separately.
			onPatternEnter() { captureGroups = 0; },
			onCapturingGroupEnter(_start, name) {
				captureGroups += 1;
				if (captureGroups > MAX_CAPTURE_GROUPS) {
					throw new Error("Security pattern exceeds the runtime capture limit");
				}
				// regexpp also requires named backreferences to resolve to one of these names.
				if (name !== null && !isPortableGroupName(name)) {
					throw new Error("Security pattern group name exceeds the runtime Unicode version");
				}
			},
		}).validatePattern(source);
		return true;
	} catch {
		return false;
	}
}
