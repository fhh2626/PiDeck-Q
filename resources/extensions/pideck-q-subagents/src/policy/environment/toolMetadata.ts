/** Tool metadata used only by the subagent environment policy. */
export interface ToolSnapshot {
	name: string;
	description?: string;
	parameters?: unknown;
	promptGuidelines?: readonly string[];
	sourceInfo?: { source?: string; path?: string };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exact package identity or scoped package directory; a same-name tool is insufficient. */
export function fromPackage(tool: ToolSnapshot, packageName: string): boolean {
	const source = tool.sourceInfo?.source ?? '';
	if (source === `npm:${packageName}` || source.startsWith(`npm:${packageName}@`)) return true;
	const path = (tool.sourceInfo?.path ?? '').replace(/\\/g, '/');
	return path.includes(`/node_modules/${packageName}/`);
}

export function isBundledSubagents(tool: ToolSnapshot): boolean {
	const source = (tool.sourceInfo?.source ?? '').toLowerCase();
	const path = (tool.sourceInfo?.path ?? '').replace(/\\/g, '/').toLowerCase();
	const isBundledPath = /(?:^|\/)pideck-q-subagents(?:\.ts|\/|$)/.test(path);
	const isBundledSource = source.includes('pideck-q-subagents');
	return isBundledPath || isBundledSource;
}

export function isSubagent(tool: ToolSnapshot): boolean {
	if (tool.name !== 'subagent') return false;
	return fromPackage(tool, 'pi-subagents') || isBundledSubagents(tool);
}
