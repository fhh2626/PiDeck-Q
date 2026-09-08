/** Fixed-path, bounded configuration I/O. No project configuration or executable templates. */
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_DESCRIPTION, DEFAULT_CONFIG, DEFAULT_PROMPTS, type Config, type Prompts } from './defaults.ts';
import { isRecord } from './contributions.ts';

export interface Settings { config: Config; prompts: Prompts }
const MAX_BYTES = 64 * 1024;

function hasCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

/** Config paths are fixed, and symlinked config directories/files are intentionally unsupported. */
async function checkDirectory(path: string): Promise<void> {
	try {
		const stat = await lstat(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Configuration path must be a real directory');
	} catch (error) {
		if (!hasCode(error, 'ENOENT')) throw error;
	}
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Configuration must be a regular file');
		if (stat.size > MAX_BYTES) throw new Error('Configuration file too large (64 KiB maximum)');
		const handle = await open(path, 'r');
		try {
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			let total = 0;
			while (total < buffer.length) {
				const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
				if (!bytesRead) break;
				total += bytesRead;
			}
			if (total > MAX_BYTES) throw new Error('Configuration file too large (64 KiB maximum)');
			return buffer.subarray(0, total).toString('utf8').replace(/^\uFEFF/, '');
		} finally { await handle.close(); }
	} catch (error) {
		if (hasCode(error, 'ENOENT')) return undefined;
		throw error;
	}
}

/** Explicit fields prevent typos, wrong types and prototype keys silently changing behavior. */
function parseConfig(text: string | undefined): Config {
	if (text === undefined) return { ...DEFAULT_CONFIG };
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error('Invalid config.json JSON'); }
	if (!isRecord(value)) throw new Error('config.json must be an object');
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`Unknown config key: ${key}`);
	}
	if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('Unsupported schemaVersion');
	const boolean = (key: keyof Config, fallback: boolean): boolean => {
		if (value[key] === undefined) return fallback;
		if (typeof value[key] !== 'boolean') throw new Error(`Config ${key} must be boolean`);
		return value[key];
	};
	const unknown = value.unknownGuidelines ?? DEFAULT_CONFIG.unknownGuidelines;
	if (unknown !== 'preserve' && unknown !== 'skip') throw new Error('Invalid unknownGuidelines policy');
	return {
		schemaVersion: 1,
		enabled: boolean('enabled', DEFAULT_CONFIG.enabled),
		replaceIdentity: boolean('replaceIdentity', DEFAULT_CONFIG.replaceIdentity),
		replaceGuidelines: boolean('replaceGuidelines', DEFAULT_CONFIG.replaceGuidelines),
		removeDocumentation: boolean('removeDocumentation', DEFAULT_CONFIG.removeDocumentation),
		pwsh: boolean('pwsh', DEFAULT_CONFIG.pwsh),
		subagent: boolean('subagent', DEFAULT_CONFIG.subagent),
		unknownGuidelines: unknown,
	};
}

/** Load all files into a fresh snapshot; callers retain last-good settings on failure. */
export async function loadSettings(agentDir: string): Promise<Settings> {
	const root = join(agentDir, 'change-pi-prompt');
	const promptDir = join(root, 'prompts');
	await checkDirectory(root);
	await checkDirectory(promptDir);
	const config = parseConfig(await readOptional(join(root, 'config.json')));
	const prompts: Prompts = { ...DEFAULT_PROMPTS };
	for (const key of Object.keys(DEFAULT_PROMPTS)) {
		if (!isPromptKey(key)) continue;
		const text = await readOptional(join(promptDir, `${key}.md`));
		if (text === undefined) continue;
		if (!text.trim()) throw new Error(`Empty template: ${key}.md; disable a target in config instead`);
		if (text.includes('<!-- change-pi-prompt:') || text.includes('<!-- /change-pi-prompt:')) throw new Error(`Reserved marker in ${key}.md`);
		for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
			if (key !== 'environment' || !['hostOs', 'today'].includes(match[1])) throw new Error(`Unsupported placeholder in ${key}.md`);
		}
		prompts[key] = text.trim();
	}
	return { config, prompts };
}

function isPromptKey(key: string): key is keyof Prompts {
	return Object.hasOwn(DEFAULT_PROMPTS, key);
}

/** Exclusive creation never overwrites a user's configuration or follows an existing symlink. */
async function createMissing(path: string, content: string): Promise<boolean> {
	try {
		await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
		return true;
	} catch (error) {
		if (hasCode(error, 'EEXIST')) return false;
		throw error;
	}
}

/** Explicit command only: export editable defaults without changing the installed extension. */
export async function initializeSettings(agentDir: string): Promise<number> {
	const root = join(agentDir, 'change-pi-prompt');
	const promptDir = join(root, 'prompts');
	await checkDirectory(root);
	await mkdir(root, { recursive: true });
	await checkDirectory(promptDir);
	await mkdir(promptDir, { recursive: true });
	let created = Number(await createMissing(join(root, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n'));
	for (const [key, text] of Object.entries(DEFAULT_PROMPTS)) {
		created += Number(await createMissing(join(promptDir, `${key}.md`), text + '\n'));
	}
	return created;
}

/** Use subagents' native customization entry point; settings changes remain explicit user actions. */
export async function initializeAgentDescription(agentDir: string): Promise<boolean> {
	return createMissing(join(agentDir, 'agent-tool-description.md'), AGENT_DESCRIPTION);
}
