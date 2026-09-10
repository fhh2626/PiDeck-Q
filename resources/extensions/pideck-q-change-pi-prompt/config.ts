/** Fixed-path, bounded configuration I/O. No project configuration or executable templates. */
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SUBAGENT_DESCRIPTION, DEFAULT_CONFIG, DEFAULT_PROMPTS, type Config, type Prompts } from './defaults.ts';
import { isRecord } from './contributions.ts';

export interface Settings { config: Config; prompts: Prompts }
export interface NativeSubagentConfigCheck {
	path: string;
	asyncByDefault: boolean | undefined;
	forceTopLevelAsync?: boolean | undefined;
	ok: boolean;
	message: string;
}
const MAX_BYTES = 64 * 1024;

export function nativeSubagentConfigPath(agentDir: string): string {
	return join(agentDir, 'extensions', 'subagent', 'config.json');
}

/** Native default is async:true; standalone Pi binaries cannot spawn background children.
 *  Requires BOTH asyncByDefault === false AND forceTopLevelAsync !== true. */
export function inspectNativeAsyncByDefault(text: string | undefined, configPath: string): NativeSubagentConfigCheck {
	if (text === undefined) {
		return {
			path: configPath,
			asyncByDefault: undefined,
			forceTopLevelAsync: undefined,
			ok: false,
			message: `未找到 ${configPath}。独立 Pi 环境要求 asyncByDefault=false 且 forceTopLevelAsync!=true。`,
		};
	}
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error('Invalid native subagent config JSON'); }
	if (!isRecord(value)) throw new Error('Native subagent config must be an object');
	const asyncByDefault = value.asyncByDefault;
	const forceTopLevelAsync = value.forceTopLevelAsync;
	if (asyncByDefault !== undefined && typeof asyncByDefault !== 'boolean') throw new Error('Native asyncByDefault must be boolean');
	if (forceTopLevelAsync !== undefined && typeof forceTopLevelAsync !== 'boolean') throw new Error('Native forceTopLevelAsync must be boolean');

	const isAsyncSafe = asyncByDefault === false;
	const isForceSafe = forceTopLevelAsync !== true;
	const ok = isAsyncSafe && isForceSafe;

	const forceInfo = forceTopLevelAsync === undefined ? 'absent' : String(forceTopLevelAsync);
	if (ok) {
		return {
			path: configPath,
			asyncByDefault,
			forceTopLevelAsync: forceTopLevelAsync as boolean | undefined,
			ok: true,
			message: `subagent-config: asyncByDefault=false, forceTopLevelAsync=${forceInfo}, foreground-safe`,
		};
	}

	return {
		path: configPath,
		asyncByDefault: typeof asyncByDefault === 'boolean' ? asyncByDefault : undefined,
		forceTopLevelAsync: typeof forceTopLevelAsync === 'boolean' ? forceTopLevelAsync : undefined,
		ok: false,
		message: `${configPath}: 独立 Pi 环境要求 asyncByDefault=false 且 forceTopLevelAsync!=true。（当前: asyncByDefault=${String(asyncByDefault)}, forceTopLevelAsync=${String(forceTopLevelAsync)}）`,
	};
}

export const UPSTREAM_ASYNC_DEFAULT_SENTENCE = 'Async/background runs are the normal default unless config sets asyncByDefault:false; set async:true explicitly when async behavior matters.';
export const UPSTREAM_ASYNC_COMPACT_SENTENCE = 'Omitted async follows asyncByDefault config; set async:true explicitly when async behavior matters.';
export const LOCAL_ASYNC_DEFAULT_SENTENCE = 'Plugin default is asyncByDefault:true (async/background). This environment requires asyncByDefault:false, so set async:false on every subagent launch; background children are unavailable.';
const LOCAL_ASYNC_WAIT_SENTENCE = 'Do not return control to wait for a background wake. Do not call bg_wait merely to wait for a subagent. Do not sleep or poll status just to wait; use bg_wait only for provider, detached, or other background work without a native notification when this turn must receive its result.';
const LOCAL_ASYNC_POLICY = `${LOCAL_ASYNC_DEFAULT_SENTENCE} ${LOCAL_ASYNC_WAIT_SENTENCE}`;

export const SUBAGENT_SCHEMA_ASYNC_SENTENCE = 'Native Pi subagents must run foreground with async:false. Never omit async for native Pi children. External CLI/job agents follow their runner contract and must not be converted to foreground; if background execution is unavailable in this standalone environment, treat that runner as unavailable.';

/** Semantic upstream policy matches; wording drift inside a bounded window still rewrites. */
const POLICY_PATTERNS: Array<{ test: RegExp; to: string }> = [
	{ test: /Run in background unless asyncByDefault:false[\s\S]{0,180}?parent must block(?: until completion)?\.?/gi, to: SUBAGENT_SCHEMA_ASYNC_SENTENCE },
	{ test: /Normally async unless asyncByDefault:false;?[\s\S]{0,240}?parent must block(?: until completion)?\.?/gi, to: SUBAGENT_SCHEMA_ASYNC_SENTENCE },
	{ test: /Set false only when the parent must block(?: until completion)?\.?/gi, to: SUBAGENT_SCHEMA_ASYNC_SENTENCE },
	{ test: /Use async\/background by default[\s\S]{0,280}?stay async\.?/gi, to: 'This environment requires `async:false` on every subagent launch; background children are unavailable. Final reviews, validation gates, oracle checks, and publication checks also use `async:false`.' },
	{ test: /Prefer async mode for every subagent launch[\s\S]{0,420}?even when the run is async\.?/gi, to: 'Use `async:false` for every subagent launch; background children are unavailable. This applies to scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, final review gates, publication gates, and scripted workflows. Keep the write path single-threaded.' },
	{ test: /In an ordinary interactive session, yield after launching[\s\S]{0,700}?if only async lanes are running[\s\S]{0,80}?yield\.?/gi, to: 'Do not yield for a background subagent completion. Launch with `async:false` and await the foreground result. Use blocking `bg_wait()` only for provider, detached, or other background work without a native notification when this turn must receive its result.' },
	{ test: /A run-to-completion user request is not by itself a[\s\S]{0,520}?Never substitute sleep or status-polling loops\.?/gi, to: 'A run-to-completion user request still uses foreground children (`async:false`). Use `bg_wait()` only for provider, detached, or other background work without a native notification. Never substitute sleep or status-polling loops.' },
	{ test: /Do not end your turn immediately after launching an async child[\s\S]{0,360}?do not convert the child to foreground\.?/gi, to: 'Do not launch a background child. Use `async:false` and consume the foreground result in this turn.' },
	{ test: /Use `async:false` only when the parent must block until completion\.[\s\S]{0,280}?because blocking is convenient\.?/gi, to: 'Set `async:false` because this environment cannot spawn background children, including short tasks, final gates, and run-to-completion requests.' },
	{ test: /Async\/background runs are the normal default unless config sets asyncByDefault:false;[\s\S]{0,900}?when this turn must receive its result\.?/gi, to: LOCAL_ASYNC_POLICY },
	{ test: /Omitted async follows asyncByDefault config;[\s\S]{0,700}?when this turn must receive its result\.?/gi, to: LOCAL_ASYNC_POLICY },
	{ test: /Use async:false only when the parent must block until completion\.[\s\S]{0,420}?do not call bg_wait merely to get a completion wake\.?/gi, to: LOCAL_ASYNC_WAIT_SENTENCE },
	{ test: /Continue independent work only until its next dependency barrier;[\s\S]{0,420}?when this turn must receive its result\.?/gi, to: LOCAL_ASYNC_WAIT_SENTENCE },
	{ test: /Scripts normally start async unless config sets asyncByDefault:false;[\s\S]{0,280}?never for final reviews or gates\.?/gi, to: 'Scripts in this environment must set async:false; background children are unavailable. Do not pass async:true, including for final reviews or gates.' },
	{ test: /Scripts normally start async unless config sets asyncByDefault:false;[\s\S]{0,360}?async workflows should omit chatProgress or use auto\/off\.?/gi, to: 'Scripts in this environment must set async:false; background children are unavailable. Blocking workflows may show a same-repo live chat card unless chatProgress is off.' },
	{ test: /Scripts normally start async unless config sets asyncByDefault:false;\s*set async:true explicitly when async behavior matters\./gi, to: 'Scripts in this environment must set async:false; background children are unavailable.' },
	{ test: /Async\/background runs are the normal default unless config sets asyncByDefault:false;\s*set async:true explicitly when async behavior matters\./gi, to: LOCAL_ASYNC_DEFAULT_SENTENCE },
	{ test: /Omitted async follows asyncByDefault config;\s*set async:true explicitly when async behavior matters\./gi, to: LOCAL_ASYNC_DEFAULT_SENTENCE },
];

function replaceAll(text: string, from: string, to: string): string {
	return text.split(from).join(to);
}

export { validateStandaloneWorkflowScript, type WorkflowValidationResult } from './workflowValidation.ts';

export function hasExplicitAsyncTrueInScript(script: string): boolean {
	let stripped = script.replace(/\/\*[\s\S]*?\*\//g, ' ');
	stripped = stripped.replace(/\/\/.*$/gm, ' ');
	stripped = stripped.replace(/`([^`\\]|\\.)*`/g, '""');
	stripped = stripped.replace(/'([^'\\]|\\.)*'/g, '""');
	stripped = stripped.replace(/"([^"\\]|\\.)*"/g, '""');
	return /\basync\s*:\s*true\b/.test(stripped);
}

export function rewriteUpstreamAsyncDefault(text: string, options?: { standalone?: boolean }): { text: string; changed: boolean } {
	if (options?.standalone === false) {
		return { text, changed: false };
	}
	let next = text;
	for (const { test, to } of POLICY_PATTERNS) next = next.replace(new RegExp(test.source, 'gi'), to);
	next = replaceAll(next, 'make exactly one top-level subagent call with async:true', 'make exactly one top-level subagent call with async:false');
	next = replaceAll(next, 'make exactly one top-level { workflowScript, async: true } call', 'make exactly one top-level { workflowScript, async: false } call');
	next = replaceAll(next, '  async: true,\n  context: "fresh"', '  async: false,\n  context: "fresh"');
	next = replaceAll(next, '  async: true,\r\n  context: "fresh"', '  async: false,\r\n  context: "fresh"');
	next = replaceAll(next, '  async: true\n})', '  async: false\n})');
	next = replaceAll(next, '  async: true\r\n})', '  async: false\r\n})');
	return { text: next, changed: next !== text };
}

export function isPiSubagentsSkillPath(path: string | undefined): boolean {
	if (!path) return false;
	let normalized = path.trim().replace(/\\/g, '/');
	try { normalized = decodeURIComponent(normalized); } catch { /* keep the raw path if it is not a URI */ }
	normalized = normalized.replace(/^file:\/\/\/([a-zA-Z]:)/, '$1').replace(/^file:\/\//, '');
	normalized = normalized.replace(/^\/\/\?(?:[a-z]\/)?/, '').replace(/^\/\/\.\//, '');
	normalized = normalized.toLowerCase().replace(/\/+$/, '');
	return /(?:^|\/)(?:node_modules\/)?(?:pi-subagents|pideck-q-subagents)\/skills(?:\/|$)/.test(normalized);
}

function rewriteContentValue(value: unknown, options?: { standalone?: boolean }): { value: unknown; changed: boolean } {
	if (typeof value === 'string') {
		const next = rewriteUpstreamAsyncDefault(value, options);
		return { value: next.text, changed: next.changed };
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map(item => {
			const rewritten = rewriteContentValue(item, options);
			changed = changed || rewritten.changed;
			return rewritten.value;
		});
		return { value: next, changed };
	}
	if (isRecord(value) && typeof value.text === 'string') {
		const next = rewriteUpstreamAsyncDefault(value.text, options);
		if (!next.changed) return { value, changed: false };
		return { value: { ...value, text: next.text }, changed: true };
	}
	return { value, changed: false };
}

export function rewriteToolResultContent(content: unknown, options?: { standalone?: boolean }): { content: unknown; changed: boolean } {
	const rewritten = rewriteContentValue(content, options);
	return { content: rewritten.value, changed: rewritten.changed };
}

export function rewriteJsonStrings(value: unknown, options?: { standalone?: boolean }): { value: unknown; changed: boolean } {
	if (typeof value === 'string') {
		const next = rewriteUpstreamAsyncDefault(value, options);
		return { value: next.text, changed: next.changed };
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map(item => {
			const rewritten = rewriteJsonStrings(item, options);
			changed = changed || rewritten.changed;
			return rewritten.value;
		});
		return { value: next, changed };
	}
	if (isRecord(value)) {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const rewritten = rewriteJsonStrings(item, options);
			changed = changed || rewritten.changed;
			next[key] = rewritten.value;
		}
		return { value: next, changed };
	}
	return { value, changed: false };
}

export function rewriteSystemPromptTools(
	systemPrompt: string,
	tools: Array<{ name: string; description?: string }>,
	options?: { standalone?: boolean },
): { systemPrompt: string; rewritten: string[] } {
	let next = systemPrompt;
	const rewritten: string[] = [];
	for (const tool of tools) {
		if (!tool.description) continue;
		const updated = rewriteUpstreamAsyncDefault(tool.description, options);
		if (!updated.changed) continue;
		const from = tool.description;
		const to = updated.text;
		if (!next.includes(from)) continue;
		next = next.split(from).join(to);
		rewritten.push(tool.name);
	}
	const promptRewrite = rewriteUpstreamAsyncDefault(next, options);
	return { systemPrompt: promptRewrite.text, rewritten: promptRewrite.changed && rewritten.length === 0 ? ['systemPrompt'] : rewritten };
}

export async function inspectNativeSubagentAsyncDefault(agentDir: string): Promise<NativeSubagentConfigCheck> {
	const configPath = nativeSubagentConfigPath(agentDir);
	try {
		const text = await readOptional(configPath);
		return inspectNativeAsyncByDefault(text, configPath);
	} catch (error) {
		return {
			path: configPath,
			asyncByDefault: undefined,
			forceTopLevelAsync: undefined,
			ok: false,
			message: `${configPath}: 配置检查失败（${error instanceof Error ? error.message : String(error)}）`,
		};
	}
}

/** Standalone Pi minimal foreground-safe configuration auto-provisioning.
 *  Only creates when completely absent; existing configurations are never modified. */
export async function ensureStandaloneSubagentConfig(agentDir: string): Promise<NativeSubagentConfigCheck> {
	return ensureStandaloneSubagentForegroundSafe(agentDir);
}

export async function ensureStandaloneSubagentForegroundSafe(agentDir: string): Promise<NativeSubagentConfigCheck> {
	const configPath = nativeSubagentConfigPath(agentDir);
	const extensionsDir = join(agentDir, 'extensions');
	const subagentDir = join(extensionsDir, 'subagent');

	let existingText: string | undefined;
	try {
		existingText = await readOptional(configPath);
	} catch (error) {
		return {
			path: configPath,
			asyncByDefault: undefined,
			forceTopLevelAsync: undefined,
			ok: false,
			message: `${configPath}: 配置检查失败（${error instanceof Error ? error.message : String(error)}）`,
		};
	}

	if (existingText !== undefined) {
		try {
			return inspectNativeAsyncByDefault(existingText, configPath);
		} catch (error) {
			return {
				path: configPath,
				asyncByDefault: undefined,
				forceTopLevelAsync: undefined,
				ok: false,
				message: `${configPath}: 配置解析失败（${error instanceof Error ? error.message : String(error)}）`,
			};
		}
	}

	// config.json does not exist. Verify parent directories are real directories (not symlinks).
	try {
		await checkDirectory(extensionsDir);
		await mkdir(extensionsDir, { recursive: true });
		await checkDirectory(subagentDir);
		await mkdir(subagentDir, { recursive: true });

		const minimalConfig = {
			asyncByDefault: false,
			forceTopLevelAsync: false,
		};
		const content = JSON.stringify(minimalConfig, null, 2) + '\n';
		await writeFile(configPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

		const verified = await inspectNativeSubagentAsyncDefault(agentDir);
		if (verified.ok) {
			return {
				...verified,
				message: `subagent-config: created foreground-safe config at ${configPath}`,
			};
		}
		return verified;
	} catch (error) {
		if (hasCode(error, 'EEXIST')) {
			// Concurrent creation race: another process created it, re-inspect existing file without overwriting
			return inspectNativeSubagentAsyncDefault(agentDir);
		}
		return {
			path: configPath,
			asyncByDefault: undefined,
			forceTopLevelAsync: undefined,
			ok: false,
			message: `${configPath}: 自动创建安全配置失败（${error instanceof Error ? error.message : String(error)}）`,
		};
	}
}

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
		pruneUnavailableShells: boolean('pruneUnavailableShells', DEFAULT_CONFIG.pruneUnavailableShells),
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
export async function initializeSubagentDescription(agentDir: string): Promise<boolean> {
	return createMissing(join(agentDir, 'subagent-tool-description.md'), SUBAGENT_DESCRIPTION);
}
