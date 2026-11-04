/** Host-side bash/powershell existence checks. No process spawn; PATH and well-known files only. */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { win32 as win32Path, posix as posixPath } from 'node:path';
import {
	defaultInspectShellPath,
	probeShellDetails,
	SHELL_TOOL_NAMES,
	type ShellProbeDetails,
	type ShellProbeHost,
	type ShellAvailability,
	type ShellToolName,
} from './shellProbe.ts';

export {
	SHELL_TOOL_NAMES,
	type ShellToolName,
	type ShellProbeStatus,
	type ShellCandidateSource,
	type ShellProbeReason,
	type ShellProbeResult,
	type ShellProbeDetails,
	type ShellPathEvidence,
	type ShellProbeHost,
	type ShellAvailability,
	type ConfiguredShellKind,
	parseShellPathFromSettings,
	resolveShellPath,
	classifyConfiguredShellKind,
	probeShellDetails,
	toRetentionAvailability,
	toKnownHostShells,
} from './shellProbe.ts';

export interface SearchAvailability {
	grep: boolean;
	find: boolean;
}

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
		inspectShellPath: (filePath: string) => defaultInspectShellPath(process.platform, process.env, filePath),
	};
}

function pathEntries(host: ShellProbeHost): string[] {
	const raw = host.env?.PATH ?? host.env?.Path ?? '';
	// Use the probed host's platform, not node:path.delimiter from the process running the tests.
	// A Linux CI process simulating Windows must still split Windows PATH with `;`.
	return raw
		.split(host.platform === 'win32' ? ';' : ':')
		.filter(Boolean);
}

function joinPath(host: ShellProbeHost, dir: string, name: string): string {
	return host.platform === 'win32' ? win32Path.join(dir, name) : posixPath.join(dir, name);
}

export function bashAvailable(host: ShellProbeHost, shellPath?: string): boolean {
	return probeShellDetails(host, shellPath).bash.status === 'available';
}

export function powershellAvailable(host: ShellProbeHost, shellPath?: string): boolean {
	return probeShellDetails(host, shellPath).powershell.status === 'available';
}

export function probeShellAvailability(host: ShellProbeHost, shellPath?: string): ShellAvailability {
	const details = probeShellDetails(host, shellPath);
	return {
		bash: details.bash.status === 'available',
		powershell: details.powershell.status === 'available',
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

/**
 * 隐藏 shell 工具后是否需要通知用户。
 * 为什么：bash 与 powershell 互为替代，Windows 上没有 Git Bash 是常态而非故障；
 * 只要修剪后仍有一个可用 shell 工具留在 active 列表里，就静默处理，不发警告也不发提示。
 * 只有「本次确实隐藏了 shell 且一个 shell 工具都不剩」时，模型才真正失去命令执行能力，值得告知。
 */
export function shouldNotifyHiddenShells(
	hidden: readonly ShellToolName[],
	nextActiveTools: readonly string[],
): boolean {
	if (hidden.length === 0) return false;
	const shellNames: readonly string[] = SHELL_TOOL_NAMES;
	return !nextActiveTools.some(name => shellNames.includes(name));
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
