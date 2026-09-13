/** Bounded parser for the default Pi layout. No searches through project/skill content. */
export interface Line { text: string; start: number; end: number }
export interface Rule { text: string; raw: string }
export interface Layout {
	identityEnd: number;
	toolsStart: number;
	toolsEnd: number;
	guidelinesStart: number;
	guidelinesEnd: number;
	docsStart: number;
	docsEnd: number;
	rules: Rule[];
}

/** Keep offsets in original text, so untouched CRLF and trailing content stay byte-identical. */
function linesOf(text: string): Line[] {
	const result: Line[] = [];
	let start = 0;
	for (const line of text.split('\n')) {
		const content = line.replace(/\r$/, '');
		result.push({ text: content, start, end: start + content.length });
		start += line.length + 1;
	}
	return result;
}

/** Parse only the contiguous default header; unsupported layouts are an explicit no-op. */
export function parseLayout(prompt: string): Layout | undefined {
	// Bound parser work and reject unusually large base headers, not large user contexts.
	const lines = linesOf(prompt.slice(0, 128 * 1024));
	let i = 0;
	const first = lines[i]?.text;
	if (!first || !/^You are\b.*\bpi\b/i.test(first)) return;
	while (lines[i]?.text) {
		if (i > 8 || /^[<#]/.test(lines[i].text)) return;
		i++;
	}
	const identityEnd = lines[i - 1]?.end;
	if (identityEnd === undefined) return;
	const skipBlank = () => { while (lines[i] && !lines[i].text.trim()) i++; };
	skipBlank();
	const toolsStart = lines[i]?.start;
	if (toolsStart === undefined || !/^(?:#{1,2} )?Available tools:$/.test(lines[i++]?.text ?? '')) return;
	let toolCount = 0;
	while (lines[i]?.text) {
		if (!/^(?:- [\w.-]+: .+|\(none\))$/.test(lines[i].text)) return;
		i++;
		toolCount++;
	}
	if (!toolCount) return;
	const toolsEnd = lines[i - 1]?.end;
	if (toolsEnd === undefined) return;
	skipBlank();
	if (lines[i]?.text === 'In addition to the tools above, you may have access to other custom tools depending on the project.') {
		i++;
		skipBlank();
	}
	const guidelinesStart = lines[i]?.start;
	if (guidelinesStart === undefined || !/^(?:#{1,2} )?Guidelines:$/.test(lines[i++]?.text ?? '')) return;
	const rules: Rule[] = [];
	while (lines[i]?.text) {
		const start = i;
		if (!lines[i].text.startsWith('- ')) return;
		i++;
		// Pi prefixes only the first line of each contribution. Support indented continuations;
		// unindented continuation/paragraph changes are ambiguous and leave the prompt untouched.
		while (lines[i]?.text && /^[ \t]+\S/.test(lines[i].text)) i++;
		const raw = prompt.slice(lines[start].start, lines[i - 1].end);
		rules.push({ raw, text: raw.slice(2).replace(/\r\n/g, '\n').trim() });
	}
	const guidelinesEnd = lines[i - 1]?.end;
	skipBlank();
	const docsStart = lines[i]?.start;
	if (guidelinesEnd === undefined || docsStart === undefined || !/^Pi documentation \([^\r\n]*\):$/.test(lines[i++]?.text ?? '')) return;
	// These three source labels identify the documentation block; body wording may drift.
	for (const label of ['Main documentation', 'Additional docs', 'Examples']) {
		if (!lines[i]?.text.startsWith(`- ${label}: `)) return;
		i++;
	}
	while (lines[i]?.text) {
		if (lines[i].text.startsWith('Current working directory: ')) break;
		if (!/^(?:- |[ \t]+\S)/.test(lines[i].text)) return;
		i++;
	}
	const docsEnd = lines[i - 1]?.end;
	if (docsEnd === undefined || docsEnd >= 128 * 1024) return;
	return { identityEnd, toolsStart, toolsEnd, guidelinesStart, guidelinesEnd, docsStart, docsEnd, rules };
}
