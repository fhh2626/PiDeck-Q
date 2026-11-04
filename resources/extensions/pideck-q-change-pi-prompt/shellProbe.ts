/**
 * Detailed shell backend probing, evidence classification, and tri-state status aggregation.
 * Keeps existence distinct from verified execution capability.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 as win32Path, posix as posixPath } from 'node:path';
import { isRecord } from './contributions.ts';
import type { WindowsGitDiscovery } from './windowsShellDiscovery.ts';

export const SHELL_TOOL_NAMES = ['bash', 'powershell'] as const;
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

export type ShellProbeStatus = 'available' | 'missing' | 'unknown';

export type ShellCandidateSource =
	| 'configured'
	| 'git-registry'
	| 'environment'
	| 'path'
	| 'legacy';

export type ShellProbeReason =
	| 'static-candidate'
	| 'no-candidate'
	| 'windows-app-alias'
	| 'access-denied'
	| 'io-error'
	| 'discovery-incomplete';

export interface ShellProbeResult {
	status: ShellProbeStatus;
	candidate?: string;
	source?: ShellCandidateSource;
	reason: ShellProbeReason;
}

export interface ShellProbeDetails {
	bash: ShellProbeResult;
	powershell: ShellProbeResult;
}

export type ShellPathEvidence =
	| { kind: 'file' }
	| { kind: 'missing' }
	| { kind: 'not-file' }
	| {
			kind: 'unknown';
			reason: 'access-denied' | 'io-error' | 'windows-app-alias';
	  };

export interface ShellProbeHost {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	exists: (path: string) => boolean;
	isExecutableFile?: (path: string) => boolean;
	inspectShellPath?: (path: string) => ShellPathEvidence;
}

export interface ShellAvailability {
	bash: boolean;
	powershell: boolean;
}

export type ConfiguredShellKind = 'bash' | 'powershell';

const BASH_BASENAMES = new Set(['bash.exe', 'bash', 'sh.exe', 'sh']);
const POWERSHELL_BASENAMES = new Set(['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell']);

const WINDOWS_LEGACY_BASH_FILES = [
	'C:\\Program Files\\Git\\bin\\bash.exe',
	'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];
const WINDOWS_LEGACY_POWERSHELL_FILES = [
	'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
	'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
	'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
];

const POSIX_BASH_FILES = ['/bin/bash', '/usr/bin/bash'];
const POSIX_PWSH_FILES = ['/usr/bin/pwsh', '/usr/local/bin/pwsh'];

function pathEntries(host: ShellProbeHost): string[] {
	const raw = host.env?.PATH ?? host.env?.Path ?? '';
	if (host.platform === 'win32') {
		return raw
			.split(';')
			.map(entry => entry.trim().replace(/^"(.*)"$/, '$1').trim())
			.filter(Boolean);
	}
	// POSIX: split by colon, preserve raw spaces and characters in directory names
	return raw
		.split(':')
		.filter(Boolean);
}

function joinPath(host: ShellProbeHost, dir: string, name: string): string {
	return host.platform === 'win32' ? win32Path.join(dir, name) : posixPath.join(dir, name);
}

function isLocatedInWindowsApps(filePath: string, env: NodeJS.ProcessEnv): boolean {
	const norm = win32Path.normalize(filePath).toLowerCase();
	const localAppData = env?.LOCALAPPDATA || (env?.USERPROFILE ? win32Path.join(env.USERPROFILE, 'AppData', 'Local') : '');
	if (localAppData) {
		const appsDir = win32Path.normalize(win32Path.join(localAppData, 'Microsoft', 'WindowsApps')).toLowerCase();
		if (norm === appsDir || norm.startsWith(appsDir + '\\')) {
			return true;
		}
	}
	// Fallback check on standard sub-path structure
	return norm.includes('\\microsoft\\windowsapps\\');
}

export interface ShellProbeFileSystem {
	stat(path: string): { isFile(): boolean };
	access(path: string, mode: number): void;
}

const DEFAULT_SHELL_FILE_SYSTEM: ShellProbeFileSystem = {
	stat: statSync,
	access: accessSync,
};

export function defaultInspectShellPath(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	filePath: string,
	fileSystem: ShellProbeFileSystem = DEFAULT_SHELL_FILE_SYSTEM,
): ShellPathEvidence {
	if (platform === 'win32') {
		if (isLocatedInWindowsApps(filePath, env)) {
			try {
				fileSystem.access(filePath, constants.F_OK);
				return { kind: 'unknown', reason: 'windows-app-alias' };
			} catch (err: unknown) {
				const code = (err as { code?: string })?.code;
				if (code === 'ENOENT' || code === 'ENOTDIR') {
					return { kind: 'missing' };
				}
				if (code === 'EACCES' || code === 'EPERM') {
					return { kind: 'unknown', reason: 'access-denied' };
				}
				return { kind: 'unknown', reason: 'io-error' };
			}
		}

		try {
			const stat = fileSystem.stat(filePath);
			if (stat.isFile()) {
				return { kind: 'file' };
			}
			return { kind: 'not-file' };
		} catch (err: unknown) {
			const code = (err as { code?: string })?.code;
			if (code === 'ENOENT' || code === 'ENOTDIR') {
				return { kind: 'missing' };
			}
			if (code === 'EACCES' || code === 'EPERM') {
				return { kind: 'unknown', reason: 'access-denied' };
			}
			return { kind: 'unknown', reason: 'io-error' };
		}
	}

	// POSIX platform
	try {
		const stat = fileSystem.stat(filePath);
		if (!stat.isFile()) {
			return { kind: 'not-file' };
		}
		try {
			fileSystem.access(filePath, constants.X_OK);
			return { kind: 'file' };
		} catch (err: unknown) {
			const code = (err as { code?: string })?.code;
			if (code === 'EACCES' || code === 'EPERM') {
				return { kind: 'unknown', reason: 'access-denied' };
			}
			return { kind: 'unknown', reason: 'io-error' };
		}
	} catch (err: unknown) {
		const code = (err as { code?: string })?.code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return { kind: 'missing' };
		}
		if (code === 'EACCES' || code === 'EPERM') {
			return { kind: 'unknown', reason: 'access-denied' };
		}
		return { kind: 'unknown', reason: 'io-error' };
	}
}

function getPathEvidence(host: ShellProbeHost, filePath: string): ShellPathEvidence {
	if (typeof host.inspectShellPath === 'function') {
		return host.inspectShellPath(filePath);
	}
	try {
		if (host.exists(filePath)) {
			return { kind: 'file' };
		}
		return { kind: 'missing' };
	} catch {
		return { kind: 'unknown', reason: 'io-error' };
	}
}

/** Read Pi settings.shellPath without executing it. Invalid JSON is treated as unset. */
export function parseShellPathFromSettings(text: string | undefined): string | undefined {
	if (typeof text !== 'string' || !text.trim()) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value) && typeof value.shellPath === 'string') return value.shellPath;
	} catch {
		return undefined;
	}
	return undefined;
}

/** Expand ~ in settings.shellPath; reject empty or relative values. */
export function resolveShellPath(shellPath: string | undefined, home = homedir()): string | undefined {
	if (typeof shellPath !== 'string') return undefined;
	const trimmed = shellPath.trim();
	if (!trimmed) return undefined;
	if (trimmed === '~') return home;
	if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2));
	if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
	return undefined;
}

/**
 * Helper to identify and parse a configured shell path without file existence checks.
 * Existence and executable capability are strictly determined by detailed file inspection.
 */
function getConfiguredShellCandidate(
	host: ShellProbeHost,
	shellPath?: string,
): { path: string; kind: ConfiguredShellKind } | undefined {
	const configured = resolveShellPath(shellPath, host.env?.HOME ?? host.env?.USERPROFILE ?? homedir());
	if (!configured) return undefined;
	const name = (host.platform === 'win32' ? win32Path.basename(configured) : posixPath.basename(configured)).toLowerCase();
	if (BASH_BASENAMES.has(name)) return { path: configured, kind: 'bash' };
	if (POWERSHELL_BASENAMES.has(name)) return { path: configured, kind: 'powershell' };
	return undefined;
}

/**
 * Classify a configured `shellPath` by its file name.
 * A configured shell contributes only to the backend it really is: `pwsh.exe` is PowerShell,
 * it must never make bash appear available. Unknown names contribute to neither backend.
 */
export function classifyConfiguredShellKind(
	host: ShellProbeHost,
	shellPath?: string,
): ConfiguredShellKind | undefined {
	const candidate = getConfiguredShellCandidate(host, shellPath);
	if (!candidate || !host.exists(candidate.path)) return undefined;
	return candidate.kind;
}

interface ShellCandidate {
	path: string;
	source: ShellCandidateSource;
}

function generateBashCandidates(
	host: ShellProbeHost,
	shellPath?: string,
	discovery?: WindowsGitDiscovery,
): ShellCandidate[] {
	const candidates: ShellCandidate[] = [];
	const seen = new Set<string>();

	const add = (candidatePath: string, source: ShellCandidateSource) => {
		const clean = host.platform === 'win32'
			? win32Path.normalize(candidatePath)
			: posixPath.normalize(candidatePath);
		const key = host.platform === 'win32' ? clean.toLowerCase() : clean;
		if (!seen.has(key)) {
			seen.add(key);
			candidates.push({ path: clean, source });
		}
	};

	// 1. Configured shellPath
	const configuredCandidate = getConfiguredShellCandidate(host, shellPath);
	if (configuredCandidate?.kind === 'bash') {
		add(configuredCandidate.path, 'configured');
	}

	if (host.platform === 'win32') {
		// 2. Registry Git roots
		if (discovery?.roots) {
			for (const root of discovery.roots) {
				add(win32Path.join(root, 'bin', 'bash.exe'), 'git-registry');
				add(win32Path.join(root, 'usr', 'bin', 'bash.exe'), 'git-registry');
			}
		}

		// 3. Environment variables (ProgramFiles, ProgramFiles(x86), ProgramW6432)
		const envDirs = [
			host.env?.ProgramFiles,
			host.env?.['ProgramFiles(x86)'],
			host.env?.ProgramW6432,
		].filter((d): d is string => typeof d === 'string' && Boolean(d.trim()));

		for (const envDir of envDirs) {
			add(win32Path.join(envDir, 'Git', 'bin', 'bash.exe'), 'environment');
			add(win32Path.join(envDir, 'Git', 'usr', 'bin', 'bash.exe'), 'environment');
		}

		// 4. PATH entries
		for (const dir of pathEntries(host)) {
			for (const name of ['bash.exe', 'bash']) {
				add(joinPath(host, dir, name), 'path');
			}
		}

		// 5. Legacy fallbacks
		for (const legacy of WINDOWS_LEGACY_BASH_FILES) {
			add(legacy, 'legacy');
		}
	} else {
		// POSIX
		for (const posixFile of POSIX_BASH_FILES) {
			add(posixFile, 'environment');
		}
		for (const dir of pathEntries(host)) {
			add(joinPath(host, dir, 'bash'), 'path');
		}
	}

	return candidates;
}

function generatePowerShellCandidates(
	host: ShellProbeHost,
	shellPath?: string,
): ShellCandidate[] {
	const candidates: ShellCandidate[] = [];
	const seen = new Set<string>();

	const add = (candidatePath: string, source: ShellCandidateSource) => {
		const clean = host.platform === 'win32'
			? win32Path.normalize(candidatePath)
			: posixPath.normalize(candidatePath);
		const key = host.platform === 'win32' ? clean.toLowerCase() : clean;
		if (!seen.has(key)) {
			seen.add(key);
			candidates.push({ path: clean, source });
		}
	};

	// 1. Configured shellPath
	const configuredCandidate = getConfiguredShellCandidate(host, shellPath);
	if (configuredCandidate?.kind === 'powershell') {
		add(configuredCandidate.path, 'configured');
	}

	if (host.platform === 'win32') {
		// 2. PATH entries
		for (const dir of pathEntries(host)) {
			for (const name of ['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell']) {
				add(joinPath(host, dir, name), 'path');
			}
		}

		// 3. SystemRoot & ProgramFiles
		const systemRoot = host.env?.SystemRoot || host.env?.SYSTEMROOT || host.env?.windir || host.env?.WINDIR;
		if (systemRoot) {
			add(win32Path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'environment');
		}
		const envDirs = [
			host.env?.ProgramFiles,
			host.env?.['ProgramFiles(x86)'],
			host.env?.ProgramW6432,
		].filter((d): d is string => typeof d === 'string' && Boolean(d.trim()));

		for (const envDir of envDirs) {
			add(win32Path.join(envDir, 'PowerShell', '7', 'pwsh.exe'), 'environment');
			add(win32Path.join(envDir, 'PowerShell', '6', 'pwsh.exe'), 'environment');
		}

		// 4. Legacy fallbacks
		for (const legacy of WINDOWS_LEGACY_POWERSHELL_FILES) {
			add(legacy, 'legacy');
		}
	} else {
		// POSIX
		for (const posixFile of POSIX_PWSH_FILES) {
			add(posixFile, 'environment');
		}
		for (const dir of pathEntries(host)) {
			add(joinPath(host, dir, 'pwsh'), 'path');
		}
	}

	return candidates;
}

function evaluateShellCandidates(
	host: ShellProbeHost,
	candidates: readonly ShellCandidate[],
	discoveryIncomplete = false,
): ShellProbeResult {
	let firstUnknown: { candidate: string; source: ShellCandidateSource; reason: ShellProbeReason } | undefined;

	for (const candidate of candidates) {
		const evidence = getPathEvidence(host, candidate.path);
		if (evidence.kind === 'file') {
			return {
				status: 'available',
				candidate: candidate.path,
				source: candidate.source,
				reason: 'static-candidate',
			};
		}
		if (evidence.kind === 'unknown' && !firstUnknown) {
			firstUnknown = {
				candidate: candidate.path,
				source: candidate.source,
				reason: evidence.reason,
			};
		}
	}

	if (firstUnknown) {
		return {
			status: 'unknown',
			candidate: firstUnknown.candidate,
			source: firstUnknown.source,
			reason: firstUnknown.reason,
		};
	}

	if (discoveryIncomplete) {
		return {
			status: 'unknown',
			reason: 'discovery-incomplete',
		};
	}

	return {
		status: 'missing',
		reason: 'no-candidate',
	};
}

export function probeShellDetails(
	host: ShellProbeHost,
	shellPath?: string,
	discovery?: WindowsGitDiscovery,
): ShellProbeDetails {
	const bashCandidates = generateBashCandidates(host, shellPath, discovery);
	const bashDiscoveryIncomplete = host.platform === 'win32' && discovery?.status === 'unknown';
	const bash = evaluateShellCandidates(host, bashCandidates, bashDiscoveryIncomplete);

	const powershellCandidates = generatePowerShellCandidates(host, shellPath);
	const powershell = evaluateShellCandidates(host, powershellCandidates, false);

	return { bash, powershell };
}

/**
 * Filter-only retention availability:
 * - available -> true (retain)
 * - unknown   -> true (do not prune on inconclusive evidence)
 * - missing   -> false (prune missing shell)
 * Used ONLY for filtering active tools and ceiling calculation; never to add unactivated tools.
 */
export function toRetentionAvailability(details: ShellProbeDetails): ShellAvailability {
	return {
		bash: details.bash.status !== 'missing',
		powershell: details.powershell.status !== 'missing',
	};
}

/**
 * Shared child agent environment tools mapping:
 * If either shell is unknown, returns undefined so reconcileChildEnvironments skips rewriting
 * managed tools allowlist, preventing unknown shells from expanding child permissions.
 */
export function toKnownHostShells(details: ShellProbeDetails): ShellAvailability | undefined {
	if (details.bash.status === 'unknown' || details.powershell.status === 'unknown') {
		return undefined;
	}
	return {
		bash: details.bash.status === 'available',
		powershell: details.powershell.status === 'available',
	};
}
