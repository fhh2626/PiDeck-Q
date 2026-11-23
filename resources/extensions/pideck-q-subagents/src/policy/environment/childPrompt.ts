/** Native child identity and authoritative active-tool facts. */
import { getActiveAgentName } from './childShellPolicy.ts';

export const CHILD_TOOL_MARKER_START = '<!-- pideck-subagent:child-tools:v1 -->';
export const CHILD_TOOL_MARKER_END = '<!-- /pideck-subagent:child-tools:v1 -->';

export function isChildSession(
	systemPrompt: string,
	_options?: { customPrompt?: string },
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	// Detached children may start before a role marker has been appended to the prompt.
	const childFlag = env.PI_SUBAGENT_CHILD;
	if (childFlag !== undefined && childFlag !== '' && childFlag !== '0' && childFlag !== 'false') return true;
	// Bundled native children are explicitly tagged by pi-subagents. A generic customPrompt is not
	// a child identity signal: parent sessions may also use --system-prompt, SYSTEM.md, or templates.
	if (getActiveAgentName(systemPrompt) !== undefined) return true;
	// Keep recognizing our own marker on subsequent turns even if an upstream prompt layer changes.
	return systemPrompt.includes(CHILD_TOOL_MARKER_START);
}

export function buildChildToolEnvironmentBlock(activeTools: readonly string[]): string {
	const hasBash = activeTools.includes('bash');
	const hasPowerShell = activeTools.includes('powershell');
	const lines = [
		CHILD_TOOL_MARKER_START,
		'## Child Tool Environment',
		'- Available tools below are authoritative for this runtime.',
		`- Active tools: ${activeTools.join(', ') || '(none)'}. This list overrides tool names in the role prompt.`,
	];

	if (!hasBash && !hasPowerShell) {
		lines.push('- No shell tool is available; use only the non-shell tools that are active in this child.');
	} else {
		lines.push(hasBash
			? '- `bash` is available.'
			: '- `bash` is unavailable. Do not call it, even if the role prompt mentions bash.');
		lines.push(hasPowerShell
			? (hasBash ? '- `powershell` is available.' : '- `powershell` is available; use `powershell` for shell commands.')
			: '- `powershell` is unavailable.');
	}
	for (const name of ['grep', 'find'] as const) {
		if (!activeTools.includes(name)) lines.push(`- \`${name}\` is unavailable. Do not call it, even if the role prompt mentions it.`);
	}
	if ((!activeTools.includes('grep') || !activeTools.includes('find')) && hasPowerShell) {
		lines.push('- For file discovery/search, use `powershell` with Get-ChildItem and Select-String instead.');
	}
	lines.push(CHILD_TOOL_MARKER_END);
	return lines.join('\n');
}

export function injectChildToolEnvironment(systemPrompt: string, activeTools: readonly string[]): string {
	const block = buildChildToolEnvironmentBlock(activeTools);
	const startIdx = systemPrompt.indexOf(CHILD_TOOL_MARKER_START);
	const endIdx = systemPrompt.indexOf(CHILD_TOOL_MARKER_END);

	if (startIdx >= 0 && endIdx >= startIdx) {
		const before = systemPrompt.slice(0, startIdx).trimEnd();
		const after = systemPrompt.slice(endIdx + CHILD_TOOL_MARKER_END.length).trimStart();
		return before + (before ? '\n\n' : '') + block + (after ? '\n\n' + after : '');
	}

	return systemPrompt.trimEnd() + '\n\n' + block;
}
