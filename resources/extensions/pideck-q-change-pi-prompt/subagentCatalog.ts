/**
 * Lightweight subagent catalog parser for bundled and custom subagents.
 * Does not import pi-subagents private runtime or agent classes.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromPackage, isBundledSubagents, isSubagent, type ToolSnapshot } from './contributions.ts';

export type AgentRunnerType = 'native' | 'external-cli' | 'external-job' | 'unknown';

export interface SubagentCatalogEntry {
	name: string;
	aliases: string[];
	runnerType: AgentRunnerType;
	tools: string[];
	systemPromptMode?: string;
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	filePath: string;
}

export interface SubagentCatalog {
	packageRoot: string | undefined;
	agents: Map<string, SubagentCatalogEntry>;
}

function parseCsvOrList(raw: string): string[] {
	return raw
		.split(/[,\n]/)
		.map(item => item.replace(/^[-*]\s*/, '').trim())
		.filter(item => item.length > 0 && !item.startsWith('#'));
}

export function parseAgentFrontmatter(content: string, filePath: string): SubagentCatalogEntry | undefined {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return undefined;
	const yamlBlock = match[1];

	let name: string | undefined;
	const aliases: string[] = [];
	let tools: string[] = [];
	let runnerType: AgentRunnerType = 'native';
	let systemPromptMode: string | undefined;
	let extensions: string[] | undefined;
	let subagentOnlyExtensions: string[] | undefined;

	let currentSection: string | undefined;
	const lines = yamlBlock.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const topMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
		if (topMatch) {
			const key = topMatch[1].trim();
			const val = topMatch[2].trim();
			currentSection = key;

			switch (key) {
				case 'name':
					name = val;
					break;
				case 'aliases':
					if (val) aliases.push(...parseCsvOrList(val));
					break;
				case 'tools':
					if (val) tools.push(...parseCsvOrList(val));
					break;
				case 'systemPromptMode':
					systemPromptMode = val;
					break;
				case 'extensions':
					if (val) extensions = parseCsvOrList(val);
					break;
				case 'subagentOnlyExtensions':
					if (val) subagentOnlyExtensions = parseCsvOrList(val);
					break;
				default:
					break;
			}
			continue;
		}

		// Indented lines under currentSection
		const indentMatch = line.match(/^\s+([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
		if (indentMatch && currentSection === 'runner') {
			const subKey = indentMatch[1].trim();
			const subVal = indentMatch[2].trim();
			if (subKey === 'type') {
				if (subVal === 'external-cli') runnerType = 'external-cli';
				else if (subVal === 'external-job') runnerType = 'external-job';
				else runnerType = 'unknown';
			}
			continue;
		}

		const listMatch = line.match(/^\s*-\s+(.+)$/);
		if (listMatch && currentSection) {
			const item = listMatch[1].trim();
			if (currentSection === 'tools') tools.push(item);
			else if (currentSection === 'aliases') aliases.push(item);
			else if (currentSection === 'extensions') (extensions ??= []).push(item);
			else if (currentSection === 'subagentOnlyExtensions') (subagentOnlyExtensions ??= []).push(item);
		}
	}

	if (!name) return undefined;

	return {
		name,
		aliases,
		runnerType,
		tools: [...new Set(tools)],
		systemPromptMode,
		extensions,
		subagentOnlyExtensions,
		filePath,
	};
}

export function findSubagentsPackageRoot(
	tools: readonly ToolSnapshot[],
	currentExtensionDir?: string,
): string | undefined {
	for (const tool of tools) {
		if (!isSubagent(tool)) continue;
		const rawPath = tool.sourceInfo?.path;
		if (rawPath) {
			const normalized = rawPath.replace(/\\/g, '/');
			if (isBundledSubagents(tool)) {
				if (normalized.endsWith('.ts') || normalized.endsWith('.js')) {
					const pkg = join(dirname(rawPath), 'pideck-q-subagents');
					if (existsSync(join(pkg, 'agents'))) return pkg;
				}
				const idx = normalized.indexOf('/pideck-q-subagents');
				if (idx >= 0) {
					const pkg = rawPath.slice(0, idx + '/pideck-q-subagents'.length);
					if (existsSync(join(pkg, 'agents'))) return pkg;
				}
			}
			if (fromPackage(tool, 'pi-subagents')) {
				const idx = normalized.indexOf('/pi-subagents');
				if (idx >= 0) {
					const pkg = rawPath.slice(0, idx + '/pi-subagents'.length);
					if (existsSync(join(pkg, 'agents'))) return pkg;
				}
			}
		}
	}

	// Fallback to relative resolution from this extension's directory
	const baseDir = currentExtensionDir
		?? (typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url)));

	const candidates = [
		resolve(baseDir, '..', 'pideck-q-subagents'),
		resolve(baseDir, '..', '..', 'resources', 'extensions', 'pideck-q-subagents'),
	];

	for (const cand of candidates) {
		if (existsSync(join(cand, 'agents'))) return cand;
	}

	return undefined;
}

export function loadSubagentCatalog(packageRoot: string | undefined): SubagentCatalog {
	const agents = new Map<string, SubagentCatalogEntry>();
	if (!packageRoot || !existsSync(packageRoot)) {
		return { packageRoot, agents };
	}

	const agentsDir = join(packageRoot, 'agents');
	if (!existsSync(agentsDir)) {
		return { packageRoot, agents };
	}

	try {
		const files = readdirSync(agentsDir);
		for (const file of files) {
			if (!file.endsWith('.md')) continue;
			const fullPath = join(agentsDir, file);
			try {
				const content = readFileSync(fullPath, 'utf8');
				const entry = parseAgentFrontmatter(content, fullPath);
				if (entry) {
					agents.set(entry.name, entry);
					for (const alias of entry.aliases) {
						agents.set(alias, entry);
					}
				}
			} catch {
				// Ignore unreadable files; fail conservative
			}
		}
	} catch {
		// Ignore directory read errors
	}

	return { packageRoot, agents };
}

export function getAgentFromCatalog(
	catalog: SubagentCatalog | undefined,
	agentName: string,
): SubagentCatalogEntry | undefined {
	return catalog?.agents.get(agentName);
}
