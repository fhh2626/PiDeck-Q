/** Tool provenance and guideline ownership. Optional packages are never imported or probed. */
import type { Config } from './defaults.ts';

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

export function isPwsh(tool: ToolSnapshot): boolean {
	return tool.name === 'bash' && fromPackage(tool, '@99percentpeople/pi-pwsh-adapter');
}

export function isSubagent(tool: ToolSnapshot): boolean {
	return tool.name === 'Agent' && fromPackage(tool, '@tintinweb/pi-subagents');
}

/** Schema shape gates batch-specific guidance; names alone do not establish semantics. */
export function hasBatchEdit(tool: ToolSnapshot): boolean {
	if (tool.name !== 'edit' || tool.sourceInfo?.source !== 'builtin') return false;
	const schema = tool.parameters;
	if (!isRecord(schema) || !isRecord(schema.properties)) return false;
	const edits = schema.properties.edits;
	return isRecord(edits) && isRecord(edits.items) && isRecord(edits.items.properties)
		&& 'oldText' in edits.items.properties && 'newText' in edits.items.properties;
}

export const CORE_RULES = new Set([
	'Be concise in your responses',
	'Show file paths clearly when working with files',
	'Use bash for file operations like ls, rg, find',
	'Use PowerShell for file operations like listing, searching, and finding files',
	'Use bash or PowerShell for file operations like listing, searching, and finding files',
]);

export function normalizeRule(text: string): string {
	return text.replace(/\r\n/g, '\n').trim();
}

/** Only claim built-ins whose replacement is emitted; preserve all other sources. */
function claimed(tool: ToolSnapshot, config: Config): boolean {
	if (config.pwsh && isPwsh(tool)) return true;
	if (config.subagent && isSubagent(tool)) return true;
	if (tool.sourceInfo?.source !== 'builtin') return false;
	if (tool.name === 'edit') return hasBatchEdit(tool);
	return ['read', 'write', 'bash', 'powershell'].includes(tool.name);
}

/** Multi-owner contributions survive whenever any owner is outside our replacement scope. */
export function classifyRules(tools: ToolSnapshot[], config: Config): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const tool of tools) {
		for (const text of tool.promptGuidelines ?? []) {
			const key = normalizeRule(text);
			if (!key) continue;
			result.set(key, (result.get(key) ?? true) && claimed(tool, config));
		}
	}
	return result;
}
