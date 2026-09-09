/** Host-side bash/powershell existence checks. No process spawn; PATH and well-known files only. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter as pathDelimiter, join, win32 as win32Path, posix as posixPath } from 'node:path';
import { isRecord } from './contributions.ts';

export const SHELL_TOOL_NAMES = ['bash', 'powershell'] as const;
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

export interface ShellProbeHost {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	exists: (path: string) => boolean;
}

export interface ShellAvailability {
	bash: boolean;
	powershell: boolean;
}

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
	};
}

function pathEntries(host: ShellProbeHost): string[] {
	const raw = host.env.PATH ?? host.env.Path ?? '';
	return raw.split(host.platform === 'win32' ? pathDelimiter : ':').filter(Boolean);
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
	const configured = resolveShellPath(shellPath, host.env.HOME ?? host.env.USERPROFILE ?? homedir());
	if (configured && host.exists(configured)) return true;
	if (host.platform === 'win32') {
		return anyFile(host, WINDOWS_BASH_FILES) || onPath(host, ['bash.exe', 'bash']);
	}
	return anyFile(host, POSIX_BASH_FILES) || onPath(host, ['bash']);
}

export function powershellAvailable(host: ShellProbeHost): boolean {
	if (host.platform === 'win32') {
		return anyFile(host, WINDOWS_POWERSHELL_FILES) || onPath(host, ['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell']);
	}
	return anyFile(host, POSIX_PWSH_FILES) || onPath(host, ['pwsh']);
}

export function probeShellAvailability(host: ShellProbeHost, shellPath?: string): ShellAvailability {
	return {
		bash: bashAvailable(host, shellPath),
		powershell: powershellAvailable(host),
	};
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
