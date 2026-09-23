/** Host-side bash/powershell existence checks. No process spawn; PATH and well-known files only. */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 as win32Path, posix as posixPath } from 'node:path';
import { isRecord } from './contributions.ts';

export const SHELL_TOOL_NAMES = ['bash', 'powershell'] as const;
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

export interface ShellProbeHost {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	exists: (path: string) => boolean;
	isExecutableFile?: (path: string) => boolean;
}

export interface ShellAvailability {
	bash: boolean;
	powershell: boolean;
}

export interface SearchAvailability {
	grep: boolean;
	find: boolean;
}

/** Which backend a configured `settings.shellPath` actually is. */
export type ConfiguredShellKind = 'bash' | 'powershell';

const BASH_BASENAMES = new Set(['bash.exe', 'bash', 'sh.exe', 'sh']);
const POWERSHELL_BASENAMES = new Set(['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell']);

const WINDOWS_BASH_FILES = [
	'C:\\Program Files\\Git\\bin\\bash.exe',
	'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];
const WINDOWS_POWERSHELL_FILES = [
	'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
	'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
	'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
];
const POSIX_BASH_FILES = ['/bin/bash', '/usr/bin/bash'];
const POSIX_PWSH_FILES = ['/usr/bin/pwsh', '/usr/local/bin/pwsh'];

export function defaultShellProbeHost(): ShellProbeHost {
	return {
		platform: process.platform,
		env: process.env,
		exists: existsSync,
		isExecutableFile: (filePath: string) => {
			try {
				const stat = statSync(filePath);
				if (!stat.isFile()) return false;
				if (process.platform !== 'win32') {
					accessSync(filePath, constants.X_OK);
				}
				return true;
			} catch {
				return false;
			}
		},
	};
}

function pathEntries(host: ShellProbeHost): string[] {
	const raw = host.env?.PATH ?? host.env?.Path ?? '';
	// Use the probed host's platform, not node:path.delimiter from the process running the tests.
	// A Linux CI process simulating Windows must still split Windows PATH with `;`.
	return raw.split(host.platform === 'win32' ? ';' : ':').filter(Boolean);
}

function joinPath(host: ShellProbeHost, dir: string, name: string): string {
	return host.platform === 'win32' ? win32Path.join(dir, name) : posixPath.join(dir, name);
}

function onPath(host: ShellProbeHost, names: readonly string[]): boolean {
	for (const dir of pathEntries(host)) {
		for (const name of names) {
			if (host.exists(joinPath(host, dir, name))) return true;
		}
	}
	return false;
}

function anyFile(host: ShellProbeHost, files: readonly string[]): boolean {
	return files.some(file => host.exists(file));
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

export function bashAvailable(host: ShellProbeHost, shellPath?: string): boolean {
	if (classifyConfiguredShellKind(host, shellPath) === 'bash') return true;
	return bashBackendPresent(host);
}

/** Only the well-known bash executables count; any configured shell is never assumed to be bash. */
function bashBackendPresent(host: ShellProbeHost): boolean {
	if (host.platform === 'win32') {
		return anyFile(host, WINDOWS_BASH_FILES) || onPath(host, ['bash.exe', 'bash']);
	}
	return anyFile(host, POSIX_BASH_FILES) || onPath(host, ['bash']);
}

export function powershellAvailable(host: ShellProbeHost, shellPath?: string): boolean {
	if (classifyConfiguredShellKind(host, shellPath) === 'powershell') return true;
	return powershellBackendPresent(host);
}

function powershellBackendPresent(host: ShellProbeHost): boolean {
	if (host.platform === 'win32') {
		return anyFile(host, WINDOWS_POWERSHELL_FILES) || onPath(host, ['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell']);
	}
	return anyFile(host, POSIX_PWSH_FILES) || onPath(host, ['pwsh']);
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
	const configured = resolveShellPath(shellPath, host.env?.HOME ?? host.env?.USERPROFILE ?? homedir());
	if (!configured || !host.exists(configured)) return undefined;
	const name = (host.platform === 'win32' ? win32Path.basename(configured) : posixPath.basename(configured)).toLowerCase();
	if (BASH_BASENAMES.has(name)) return 'bash';
	if (POWERSHELL_BASENAMES.has(name)) return 'powershell';
	return undefined;
}

export function probeShellAvailability(host: ShellProbeHost, shellPath?: string): ShellAvailability {
	// Resolve the configured shell once, then let it contribute to exactly one backend.
	const configuredKind = classifyConfiguredShellKind(host, shellPath);
	return {
		bash: configuredKind === 'bash' || bashBackendPresent(host),
		powershell: configuredKind === 'powershell' || powershellBackendPresent(host),
	};
}

function checkExecutable(host: ShellProbeHost, filePath: string): boolean {
	if (typeof host.isExecutableFile === 'function') {
		return host.isExecutableFile(filePath);
	}
	return host.exists(filePath);
}

function findExecutableOnPath(host: ShellProbeHost, candidateNames: readonly string[]): boolean {
	for (const name of candidateNames) {
		for (const dir of pathEntries(host)) {
			const candidatePath = joinPath(host, dir, name);
			if (host.exists(candidatePath) && checkExecutable(host, candidatePath)) {
				return true;
			}
		}
	}
	return false;
}

/** Pi's grep/find tools invoke rg/fd. Check both PATH and Pi's managed binary directory. */
export function probeSearchAvailability(host: ShellProbeHost, agentDir: string): SearchAvailability {
	const isWin = host.platform === 'win32';
	const managedDir = joinPath(host, agentDir, 'bin');

	// Managed binary names: Pi only looks for rg/fd in managed bin (never fdfind).
	const managedRgName = isWin ? 'rg.exe' : 'rg';
	const managedFdName = isWin ? 'fd.exe' : 'fd';

	const managedRgPath = joinPath(host, managedDir, managedRgName);
	const managedFdPath = joinPath(host, managedDir, managedFdName);

	// Probe grep: managed binary takes precedence. If present but not executable, Pi fails to execute it.
	let grepAvailable = false;
	if (host.exists(managedRgPath)) {
		grepAvailable = checkExecutable(host, managedRgPath);
	} else {
		const pathCandidates = isWin ? ['rg.exe'] : ['rg'];
		grepAvailable = findExecutableOnPath(host, pathCandidates);
	}

	// Probe find: managed binary takes precedence. If present but not executable, Pi fails to execute it.
	let findAvailable = false;
	if (host.exists(managedFdPath)) {
		findAvailable = checkExecutable(host, managedFdPath);
	} else {
		// On PATH: fd first, then fdfind
		const pathCandidates = isWin ? ['fd.exe', 'fdfind.exe'] : ['fd', 'fdfind'];
		findAvailable = findExecutableOnPath(host, pathCandidates);
	}

	return { grep: grepAvailable, find: findAvailable };
}

export function hideUnavailableSearchTools(
	activeTools: readonly string[],
	availability: SearchAvailability,
): { next: string[]; hidden: Array<'grep' | 'find'> } {
	const hidden: Array<'grep' | 'find'> = [];
	const next = activeTools.filter(name => {
		if ((name === 'grep' || name === 'find') && !availability[name]) {
			hidden.push(name);
			return false;
		}
		return true;
	});
	return { next, hidden };
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

/** Drop only bash/powershell whose backends are missing; leave every other active tool untouched. */
export function hideUnavailableShellTools(
	activeTools: readonly string[],
	availability: ShellAvailability,
	options: { keepBash?: boolean } = {},
): { next: string[]; hidden: ShellToolName[] } {
	const hidden: ShellToolName[] = [];
	const next = activeTools.filter(name => {
		// A bash-named pwsh adapter still works without Git Bash; do not hide that slot.
		if (name === 'bash' && !availability.bash && !options.keepBash) {
			hidden.push('bash');
			return false;
		}
		if (name === 'powershell' && !availability.powershell) {
			hidden.push('powershell');
			return false;
		}
		return true;
	});
	return { next, hidden };
}

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
