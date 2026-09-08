/** Pure, bounded system-prompt transformation; no filesystem, process, or model calls. */
import { type Config, type Prompts } from './defaults.ts';
import { classifyRules, CORE_RULES, hasBatchEdit, isPwsh, isSubagent, type ToolSnapshot } from './contributions.ts';
import { parseLayout } from './layout.ts';

export interface PromptOptions { customPrompt?: string; appendSystemPrompt?: string }
export interface TransformInput {
	systemPrompt: string;
	options?: PromptOptions;
	tools: ToolSnapshot[];
	activeTools: string[];
	config: Config;
	prompts: Prompts;
	hostOs: string;
	today: string;
}
export interface TransformResult { systemPrompt: string; diagnostics: string[] }
export const OWN_START = '<!-- change-pi-prompt:v1 -->';
export const OWN_END = '<!-- /change-pi-prompt:v1 -->';
interface Patch { start: number; end: number; expected: string; replacement: string }

/** Every patch is checked against the same original input and cannot overlap. */
function applyPatches(original: string, patches: Patch[]): string {
	const ordered = [...patches].sort((a, b) => a.start - b.start);
	let end = 0;
	let result = '';
	for (const patch of ordered) {
		if (patch.start < end || patch.end < patch.start || original.slice(patch.start, patch.end) !== patch.expected) {
			throw new Error('invalid-patch-plan');
		}
		result += original.slice(end, patch.start) + patch.replacement;
		end = patch.end;
	}
	return result + original.slice(end);
}

/** Render only sections supported by the active tool set. Runtime facts stay with providers. */
function renderGuidelines(input: TransformInput, tools: ToolSnapshot[]): string {
	const p = input.prompts;
	const has = (name: string) => input.activeTools.includes(name);
	const sections = [p.execution, p.tools];
	if (has('read')) sections.push(p.read);
	if (has('edit')) {
		sections.push(p.edit);
		if (tools.some(hasBatchEdit)) sections.push(p.batchEdit);
	}
	if (has('write')) sections.push(p.write);
	if (input.config.pwsh && tools.some(isPwsh)) sections.push(p.pwsh);
	else if (has('bash') || has('powershell')) sections.push(p.shell);
	if (has('ask_question')) sections.push(p.userInput);
	if (has('todo')) sections.push(p.taskTracking);
	if (input.config.subagent && tools.some(isSubagent)) sections.push(p.delegation);
	sections.push(p.validation, p.communication);
	sections.push(p.environment.replace(/\{\{(hostOs|today)\}\}/g, (_, key: string) => key === 'hostOs' ? input.hostOs : input.today));
	return sections.join('\n\n');
}

/** Unknown layouts and custom/child prompts never receive partially applied transformations. */
export function transformSystemPrompt(input: TransformInput): TransformResult {
	const original = input.systemPrompt;
	const unchanged = (reason: string): TransformResult => ({ systemPrompt: original, diagnostics: [reason] });
	if (!input.config.enabled) return unchanged('disabled');
	if (original.startsWith(OWN_START + '\n') || original.startsWith(OWN_START + '\r\n')) return unchanged('already-transformed');
	// Subagents use customPrompt too. Preserve their role, active_agent tag, memory and inherited prefix.
	if (input.options?.customPrompt) return unchanged('custom-or-child-prompt: skipped');
	const layout = parseLayout(original);
	if (!layout) return unchanged('unsupported-layout: original preserved');
	// APPEND_SYSTEM is user-owned even if it resembles our documentation/list syntax.
	const append = input.options?.appendSystemPrompt;
	if (append) {
		const at = original.indexOf(append);
		if (at < 0 || at < layout.docsEnd) return unchanged('ambiguous-append-boundary: original preserved');
	}
	const tools = input.tools.filter(tool => input.activeTools.includes(tool.name));
	const diagnostics = [
		`pwsh: ${input.config.pwsh && tools.some(isPwsh) ? 'active' : 'absent, inactive, unrecognized or disabled'}`,
		`subagent: ${input.config.subagent && tools.some(isSubagent) ? 'active' : 'absent, inactive, unrecognized or disabled'}`,
	];
	const patches: Patch[] = [];
	const add = (start: number, end: number, replacement: string) => {
		patches.push({ start, end, replacement, expected: original.slice(start, end) });
	};
	if (input.config.replaceIdentity) add(0, layout.identityEnd, input.prompts.identity);
	if (input.config.replaceGuidelines) {
		const ownership = classifyRules(tools, input.config);
		const preserved: string[] = [];
		let unknown = 0;
		for (const rule of layout.rules) {
			const owned = ownership.get(rule.text);
			if (owned === true || (owned === undefined && CORE_RULES.has(rule.text))) continue;
			preserved.push(rule.raw);
			if (owned === undefined) unknown++;
		}
		if (unknown && input.config.unknownGuidelines === 'skip') return unchanged(`unknown-guidelines: ${unknown}; original preserved`);
		diagnostics.push(`guidelines: replaced; preserved ${preserved.length}, unclassified ${unknown}`);
		const retained = preserved.length ? '\n\n## Additional tool and extension guidance\n' + preserved.join('\n') : '';
		add(layout.guidelinesStart, layout.guidelinesEnd, renderGuidelines(input, tools) + retained);
	}
	if (input.config.removeDocumentation) add(layout.docsStart, layout.docsEnd, '');
	if (!patches.length) return unchanged('all-targets-disabled');
	// Wrap only the known base, never AGENTS.md/skills/appended instructions. These markers ensure
	// inherited/repeated inputs remain idempotent; Pi normally rebuilds its base on each user turn.
	const base = original.slice(0, layout.docsEnd);
	const transformed = applyPatches(base, patches);
	return {
		systemPrompt: OWN_START + '\n' + transformed.trimEnd() + '\n' + OWN_END + original.slice(layout.docsEnd),
		diagnostics,
	};
}
