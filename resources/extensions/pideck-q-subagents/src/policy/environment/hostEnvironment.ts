/** Shell/search backend discovery shared by the parent and its native children. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveExtensionLocale, shellUnavailableCopy, type ExtensionLocale } from './copy.ts';
import { createWindowsGitDiscoveryProvider, type WindowsGitDiscoveryProvider } from './windowsShellDiscovery.ts';
import {
	defaultShellProbeHost, hideUnavailableSearchTools, hideUnavailableShellTools,
	parseShellPathFromSettings, probeSearchAvailability, probeShellDetails,
	shouldNotifyHiddenShells, toRetentionAvailability, type ShellProbeHost,
} from './shellAvailability.ts';

export interface HostEnvironmentOptions {
	probeHost?: ShellProbeHost;
	windowsGitDiscovery?: WindowsGitDiscoveryProvider;
	locale?: ExtensionLocale;
}

/** Own backend probes independently of the optional system-prompt optimizer. */
export function createHostEnvironment(pi: ExtensionAPI, agentDir: string, options: HostEnvironmentOptions = {}) {
	const probeHost: ShellProbeHost = options.probeHost ? {
		...defaultShellProbeHost(),
		isExecutableFile: options.probeHost.isExecutableFile,
		inspectShellPath: options.probeHost.inspectShellPath,
		...options.probeHost,
	} : defaultShellProbeHost();
	const discover = options.windowsGitDiscovery ?? (options.probeHost
		? async () => ({ roots: [], status: 'complete' as const })
		: createWindowsGitDiscoveryProvider({ platform: process.platform, env: process.env }));
	const copy = shellUnavailableCopy(options.locale ?? resolveExtensionLocale(probeHost.env));
	const warned = new Set<string>();
	const notify = (ctx: ExtensionContext, message: string) => {
		if (warned.has(message)) return;
		if (warned.size >= 64) warned.clear();
		warned.add(message);
		if (ctx.hasUI) ctx.ui.notify(message, 'warning');
		else process.stderr.write(`[subagent] ${message}\n`);
	};
	const probeShells = async () => {
		let shellPath: string | undefined;
		try { shellPath = parseShellPathFromSettings(await readFile(join(agentDir, 'settings.json'), 'utf8')); }
		catch { /* An absent shell setting uses the actual host defaults. */ }
		const discovery = await discover().catch(() => ({ roots: [], status: 'unknown' as const }));
		return probeShellDetails(probeHost, shellPath, discovery);
	};
	const prune = async (ctx: ExtensionContext) => {
		const details = await probeShells();
		if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return details;
		const shell = hideUnavailableShellTools(pi.getActiveTools(), toRetentionAvailability(details));
		const search = hideUnavailableSearchTools(shell.next, probeSearchAvailability(probeHost, agentDir));
		if (shell.hidden.length || search.hidden.length) pi.setActiveTools(search.next);
		if (shouldNotifyHiddenShells(shell.hidden, search.next)) notify(ctx, copy.allShellsHidden);
		for (const name of search.hidden) notify(ctx, copy.searchHidden(name));
		return details;
	};
	return {
		probeHost, probeShells, prune, notify,
		probeSearch: () => probeSearchAvailability(probeHost, agentDir),
		reset: () => warned.clear(),
	};
}

export type HostEnvironment = ReturnType<typeof createHostEnvironment>;
