/** Filter inactive builtin catalog rows without probing or changing runtime tools. */
/** Remove inactive bash/powershell rows from Pi's Available tools list; keep all other rows. */
export function filterUnavailableShellToolLines(block: string, activeTools: readonly string[]): string {
	const drop = new Set<string>();
	if (!activeTools.includes('bash')) drop.add('bash');
	if (!activeTools.includes('powershell')) drop.add('powershell');
	if (drop.size === 0) return block;
	const newline = block.includes('\r\n') ? '\r\n' : '\n';
	const lines = block.split(/\r?\n/);
	const kept = lines.filter(line => {
		const match = /^- ([\w.-]+): /.exec(line);
		return !match || !drop.has(match[1]);
	});
	const hasItem = kept.some(line => /^- [\w.-]+: /.test(line) || line.trim() === '(none)');
	if (!hasItem) {
		const heading = kept.find(line => /Available tools:$/.test(line));
		return heading ? heading + newline + '(none)' : '(none)';
	}
	return kept.join(newline);
}

/** Keep the model-facing catalog consistent with tools hidden after backend probing. */
export function filterUnavailableSearchToolLines(block: string, activeTools: readonly string[]): string {
	const drop = new Set(['grep', 'find'].filter(name => !activeTools.includes(name)));
	if (drop.size === 0) return block;
	const lines = block.split(/\r?\n/).filter(line => {
		const match = /^- ([\w.-]+): /.exec(line);
		return !match || !drop.has(match[1]);
	});
	if (!lines.some(line => /^- [\w.-]+: /.test(line) || line.trim() === '(none)')) {
		const heading = lines.find(line => /Available tools:$/.test(line));
		return heading ? heading + (block.includes('\r\n') ? '\r\n' : '\n') + '(none)' : '(none)';
	}
	return lines.join(block.includes('\r\n') ? '\r\n' : '\n');
}
