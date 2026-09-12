/**
 * Security-policy correction for a PowerShell backend exposed through a child `bash` slot.
 *
 * PiDeck's security gate intentionally selects Bash vs PowerShell rules by tool name. Native child
 * allowlists may force our PowerShell backend to keep the historical `bash` name, so the normal gate
 * would otherwise evaluate only Bash patterns. This helper supplements that gate: it evaluates both
 * rule sets and intervenes only when the PowerShell interpretation is stricter. The ordinary gate
 * still runs afterwards, so this can only preserve or tighten the configured policy, never weaken it.
 */
import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { isChildPowerShellBridge, isPwsh } from './contributions.ts';

type SecurityAction = 'allow' | 'ask' | 'deny';

interface SecurityLevelConfig {
	id: string;
	name: string;
	toolActions: Partial<Record<string, SecurityAction>>;
	denyBashPatterns: string[];
	denyPowerShellPatterns?: string[];
	defaultAction: SecurityAction;
}

interface SecurityPolicySnapshot {
	schemaVersion: number;
	enabled: boolean;
	defaultLevelId: string;
	levels: SecurityLevelConfig[];
	sessionLevels: Record<string, string>;
}

const SECURITY_SCHEMA_VERSION = 1;
const DEFAULT_POWERSHELL_DENY_PATTERNS = [
	'\\b(Remove-Item|rm|del|erase|rmdir)\\b',
	'\\b(Set-Content|Add-Content|Clear-Content|Out-File)\\b',
	'\\b(New-Item|mkdir|ni)\\b',
	'\\b(Move-Item|mv|Copy-Item|cp|Rename-Item)\\b',
	'\\b(Set-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Acl)\\b',
	'\\b(Invoke-Expression|Start-Process|Stop-Process)\\b',
	'(^|[^<])>(?!>)',
	'>>',
	'\\bgit\\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|branch\\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\\b',
	'\\bnpm\\s+(install|uninstall|update|ci|publish)\\b',
	'\\bpnpm\\s+(add|install|remove|update|publish)\\b',
	'\\byarn\\s+(add|install|remove|publish)\\b',
];

function loadSecuritySnapshot(path: string | undefined): SecurityPolicySnapshot | undefined {
	if (!path) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as SecurityPolicySnapshot;
		if (parsed.schemaVersion !== SECURITY_SCHEMA_VERSION || !parsed.enabled) return undefined;
		if (!Array.isArray(parsed.levels) || !parsed.sessionLevels) return undefined;
		return parsed;
	} catch {
		// Match the security gate's fail-safe behavior for a missing/unreadable snapshot.
		return undefined;
	}
}

function resolveLevel(config: SecurityPolicySnapshot, sessionId: string): SecurityLevelConfig | undefined {
	const levelId = config.sessionLevels[sessionId] ?? config.defaultLevelId;
	return config.levels.find(level => level.id === levelId)
		?? config.levels.find(level => level.id === 'standard')
		?? config.levels[0];
}

function matchesAny(patterns: readonly string[], command: string, caseInsensitive = false): boolean {
	return patterns.some(pattern => {
		try {
			return new RegExp(pattern, caseInsensitive ? 'i' : undefined).test(command);
		} catch {
			return false;
		}
	});
}

function shellAction(level: SecurityLevelConfig, shell: 'bash' | 'powershell', command: string): SecurityAction {
	const dangerous = shell === 'powershell'
		? matchesAny(level.denyPowerShellPatterns ?? DEFAULT_POWERSHELL_DENY_PATTERNS, command, true)
		: matchesAny(level.denyBashPatterns ?? [], command);
	const toolAction = level.toolActions?.[shell] ?? level.defaultAction;
	if (!dangerous) return toolAction;
	if (toolAction === 'allow') return 'allow';
	if (level.defaultAction === 'deny') return 'deny';
	return 'ask';
}

function severity(action: SecurityAction): number {
	return action === 'deny' ? 2 : action === 'ask' ? 1 : 0;
}

function hasPowerShellBackedBash(pi: ExtensionAPI): boolean {
	if (typeof pi.getAllTools !== 'function') return false;
	const bash = pi.getAllTools().find(tool => tool.name === 'bash');
	return !!bash && (isChildPowerShellBridge(bash) || isPwsh(bash));
}

async function confirmPowerShellAction(
	ctx: ExtensionContext,
	command: string,
	levelName: string,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	try {
		const choice = await ctx.ui.select(
			`PiDeck 安全确认：允许 PowerShell 命令吗？\n${command.slice(0, 500)}\n\n[等级: ${levelName}]`,
			['允许执行', '拒绝'],
		);
		return choice === '允许执行';
	} catch {
		return false;
	}
}

/**
 * Supplement PiDeck's normal security gate for a PowerShell-backed child `bash` slot.
 * Returns a block result only when the semantic PowerShell policy is stricter than the Bash-name
 * policy that the normal security gate will apply afterwards.
 */
export async function enforcePowerShellBackedBashSecurity(
	pi: ExtensionAPI,
	event: ToolCallEvent,
	ctx: ExtensionContext,
	options: {
		enabled: boolean;
		securityConfigPath?: string;
		securitySessionId?: string;
	},
): Promise<{ block: true; reason: string } | undefined> {
	if (!options.enabled || event.toolName !== 'bash') return undefined;
	if (!hasPowerShellBackedBash(pi)) return undefined;

	const input = event.input as Record<string, unknown>;
	const command = typeof input.command === 'string' ? input.command : '';
	const config = loadSecuritySnapshot(options.securityConfigPath ?? process.env.PIDECK_SECURITY_CONFIG);
	if (!config) return undefined;
	const level = resolveLevel(config, options.securitySessionId ?? process.env.PIDECK_SESSION_ID ?? '');
	if (!level || level.id === 'off') return undefined;

	const bashAction = shellAction(level, 'bash', command);
	const powerShellAction = shellAction(level, 'powershell', command);
	if (severity(powerShellAction) <= severity(bashAction)) return undefined;

	const target = command.slice(0, 200);
	if (powerShellAction === 'deny') {
		return {
			block: true,
			reason: `[安全管理·${level.name}] PowerShell 命令被拒绝${target ? `: ${target}` : ''}`,
		};
	}

	// PowerShell says ask while the Bash-name policy says allow. Ask here; the normal gate can then
	// continue without a duplicate prompt because its own result is less strict.
	const allowed = await confirmPowerShellAction(ctx, command, level.name);
	if (allowed) return undefined;
	return {
		block: true,
		reason: `[安全管理·${level.name}] PowerShell 命令已被用户拒绝${target ? `: ${target}` : ''}`,
	};
}
