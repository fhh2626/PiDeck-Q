import assert from 'node:assert/strict';
import test from 'node:test';
import { transformSystemPrompt } from '../transform.ts';
import { DEFAULT_CONFIG, DEFAULT_PROMPTS } from '../defaults.ts';

const identity = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';
const doc = `Pi documentation (read only when the user asks about pi itself):
- Main documentation: /pi/README.md
- Additional docs: /pi/docs
- Examples: /pi/examples (extensions, custom tools, SDK)
- Follow documentation links, including newly added topics.`;
const coreRules = ['Be concise in your responses', 'Show file paths clearly when working with files'];
const tool = (name, guidelines = [], source = 'builtin', path = `<builtin:${name}>`) => ({ name, description: '', parameters: {}, promptGuidelines: guidelines, sourceInfo: { source, path } });
function fixture(rules = coreRules, tail = '\n\n<project_context>KEEP EXACTLY\r\n</project_context>\nCurrent working directory: /project') {
  return `${identity}\n\nAvailable tools:\n- read: Read file contents\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n${rules.map(x => '- ' + x).join('\n')}\n\n${doc}${tail}`;
}
function run(prompt = fixture(), tools = [tool('read')], overrides = {}) {
  return transformSystemPrompt({ systemPrompt: prompt, options: {}, tools, activeTools: tools.map(t => t.name), config: DEFAULT_CONFIG, prompts: DEFAULT_PROMPTS, hostOs: 'Windows', today: '2026-09-08', ...overrides });
}

test('Pi-only installation needs neither optional plugin nor interactive tools', () => {
  const result = run();
  assert.notEqual(result.systemPrompt, fixture());
  assert.match(result.systemPrompt, /You are Pi,/);
  assert.doesNotMatch(result.systemPrompt, /Pi documentation|ask_question|`todo`|PowerShell|## Delegation/);
  assert.ok(result.systemPrompt.endsWith('\n\n<project_context>KEEP EXACTLY\r\n</project_context>\nCurrent working directory: /project'));
});
test('inactive bash and powershell rows disappear with their shell guidelines', () => {
  const prompt = fixture(coreRules).replace(
    'Available tools:\n- read: Read file contents',
    'Available tools:\n- bash: Execute a bash command\n- powershell: Execute a PowerShell command\n- read: Read file contents',
  );
  const result = run(prompt, [tool('bash'), tool('powershell'), tool('read')], { activeTools: ['read'] });
  assert.doesNotMatch(result.systemPrompt, /- bash: |- powershell: /);
  assert.match(result.systemPrompt, /- read: Read file contents/);
  assert.doesNotMatch(result.systemPrompt, /For shell commands|For `bash`/);
  assert.match(result.diagnostics.join('\n'), /shell-tools: pruned/);
});
test('active powershell keeps the generic shell guideline and its catalog row', () => {
  const prompt = fixture(coreRules).replace(
    'Available tools:\n- read: Read file contents',
    'Available tools:\n- bash: Execute a bash command\n- powershell: Execute a PowerShell command\n- read: Read file contents',
  );
  const result = run(prompt, [tool('bash'), tool('powershell'), tool('read')], { activeTools: ['powershell', 'read'] });
  assert.doesNotMatch(result.systemPrompt, /- bash: /);
  assert.match(result.systemPrompt, /- powershell: Execute a PowerShell command/);
  assert.match(result.systemPrompt, /For shell commands/);
});
test('tool bullets stay in one list without blank lines', () => {
  const edit = tool('edit');
  edit.parameters = { type: 'object', properties: { edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' } } } } } };
  const result = run(fixture(), [tool('read'), edit, tool('write'), tool('bash')]);
  assert.match(result.systemPrompt, /## Tools\n- Follow the active tools' schemas[^]*?- Use `read` to inspect files instead of shell commands\.\n- Use `edit` for focused changes[^]*?- Use one `edit` call[^]*?- Use `write` only for new files or complete rewrites\.\n- For shell commands/);
  assert.doesNotMatch(result.systemPrompt, /## Tools[^]*?\n\n-/);
  assert.match(result.systemPrompt, /## Tools\n- Follow[^]*?\n\n## Validation/);
});
test('custom system prompts with matching keywords are not modified', () => {
  assert.equal(run(fixture(), [], { options: { customPrompt: fixture() } }).systemPrompt, fixture());
});
test('missing documentation boundary cannot consume project instructions', () => {
  const input = fixture().replace(doc, '<project_context>\nKEEP\n' + doc + '\n</project_context>');
  assert.equal(run(input).systemPrompt, input);
});
test('documentation prose changes do not depend on tui.md ending', () => {
  assert.doesNotMatch(run().systemPrompt, /newly added topics/);
});
test('identity wording changes within the Pi header are supported', () => {
  assert.match(run(fixture().replace(identity, 'You are a coding assistant inside pi. Help users solve development tasks.')).systemPrompt, /You are Pi,/);
});
test('unknown extension guidance survives byte-for-byte, including multiline rules', () => {
  const rule = 'UNRELATED guidance\n  - keep this nested rule';
  assert.ok(run(fixture([...coreRules, rule])).systemPrompt.includes('- ' + rule));
});
test('pwsh updated guidelines are recognized from current source metadata', () => {
  const rule = 'UPDATED shell provider instruction';
  const tools = [tool('bash', [rule], 'npm:@99percentpeople/pi-pwsh-adapter', '/npm/@99percentpeople/pi-pwsh-adapter/index.min.js')];
  const result = run(fixture([...coreRules, rule]), tools);
  assert.doesNotMatch(result.systemPrompt, /UPDATED shell/);
  assert.match(result.systemPrompt, /runtime.*tool description/);
});
test('same-name bash supplied by another extension is not treated as pwsh', () => {
  const rule = 'REMOTE runtime constraint';
  const result = run(fixture([...coreRules, rule]), [tool('bash', [rule], 'npm:other', '/other/index.ts')]);
  assert.ok(result.systemPrompt.includes(rule));
});
test('native default-mode safeguards survive while delegation is added', () => {
  const rule = 'UPDATED delegation guidance';
  const tools = [tool('subagent', [rule], 'npm:pi-subagents@0.66.0', '/npm/pi-subagents/src/index.ts')];
  const result = run(fixture([...coreRules, rule]), tools);
  assert.match(result.systemPrompt, /UPDATED delegation/);
  assert.match(result.systemPrompt, /## Delegation/);
  assert.ok(run(fixture([...coreRules, rule]), [tool('subagent', [rule], 'npm:other')]).systemPrompt.includes(rule));
});
test('disabled optional tools neither contribute replacements nor lose their rules', () => {
  const rule = 'optional plugin constraint';
  const tools = [tool('subagent', [rule], 'npm:pi-subagents')];
  const result = run(fixture([...coreRules, rule]), tools, { activeTools: [] });
  assert.ok(result.systemPrompt.includes(rule));
  assert.doesNotMatch(result.systemPrompt, /## Delegation/);
});
test('custom mode without prompt metadata still receives delegation by provenance', () => {
  const native = { name: 'subagent', sourceInfo: { source: 'npm:pi-subagents' } };
  const result = run(fixture(), [native]);
  assert.match(result.systemPrompt, /exactly one top-level subagent call with async:false/);
  assert.doesNotMatch(result.systemPrompt, /run_in_background|subagent_type/);
});
test('installed package paths establish provenance without a package source label', () => {
  const native = tool('subagent', [], 'path', 'C:\\node_modules\\pi-subagents\\index.ts');
  assert.match(run(fixture(), [native]).systemPrompt, /## Delegation/);
});
test('legacy provider and lookalike package names are never adapted', () => {
  for (const candidate of [
    tool('Agent', ['KEEP'], 'npm:@tintinweb/pi-subagents'),
    tool('subagent', ['KEEP'], 'npm:@tintinweb/pi-subagents'),
    tool('subagent', ['KEEP'], 'npm:pi-subagents-other'),
    tool('Agent', ['KEEP'], 'npm:pi-subagents'),
  ]) {
    const result = run(fixture([...coreRules, 'KEEP']), [candidate]);
    assert.match(result.systemPrompt, /KEEP/);
    assert.doesNotMatch(result.systemPrompt, /## Delegation/);
  }
});
test('disabled subagent adaptation and companion tools preserve upstream guidance', () => {
  const tools = [tool('subagent', ['NATIVE'], 'npm:pi-subagents'), tool('bg_wait', ['WAIT'], 'npm:pi-subagents'), tool('subagent_supervisor', ['SUPERVISOR'], 'npm:pi-subagents')];
  const result = run(fixture([...coreRules, 'NATIVE', 'WAIT', 'SUPERVISOR']), tools, { config: { ...DEFAULT_CONFIG, subagent: false } });
  assert.doesNotMatch(result.systemPrompt, /## Delegation/);
  for (const rule of ['NATIVE', 'WAIT', 'SUPERVISOR']) assert.ok(result.systemPrompt.includes(rule));
  const enabled = run(fixture([...coreRules, 'NATIVE', 'WAIT', 'SUPERVISOR']), tools);
  assert.ok(enabled.systemPrompt.includes('WAIT'));
  assert.ok(enabled.systemPrompt.includes('SUPERVISOR'));
});
test('rules co-owned by untargeted tools are preserved', () => {
  const rule = 'SHARED guidance';
  const tools = [tool('bash', [rule], 'npm:@99percentpeople/pi-pwsh-adapter'), tool('remote', [rule], 'npm:other')];
  assert.ok(run(fixture([...coreRules, rule]), tools).systemPrompt.includes(rule));
});
test('replacement text with dollar syntax is literal and repeated transformation is stable', () => {
  const prompts = { ...DEFAULT_PROMPTS, identity: 'Custom $& $1 $` identity' };
  const first = run(fixture(), undefined, { prompts });
  assert.ok(first.systemPrompt.includes(prompts.identity));
  assert.equal(run(first.systemPrompt, undefined, { prompts }).systemPrompt, first.systemPrompt);
});
test('CRLF input preserves untouched suffix exactly', () => {
  const input = fixture().replace(/\r?\n/g, '\r\n');
  const suffix = input.slice(input.indexOf('\r\n\r\n<project_context>'));
  assert.ok(run(input).systemPrompt.endsWith(suffix));
});
test('strict unknown-guideline policy rolls back the entire transformation', () => {
  const input = fixture([...coreRules, 'UNKNOWN']);
  assert.equal(run(input, undefined, { config: { ...DEFAULT_CONFIG, unknownGuidelines: 'skip' } }).systemPrompt, input);
});
test('missing metadata preserves tool instructions rather than guessing ownership', () => {
  const input = fixture([...coreRules, 'Tool-specific instruction']);
  assert.ok(run(input, [], { options: undefined }).systemPrompt.includes('Tool-specific instruction'));
});
test('configuration can disable all rewriting', () => {
  assert.equal(run(fixture(), undefined, { config: { ...DEFAULT_CONFIG, enabled: false } }).systemPrompt, fixture());
});
test('pruneUnavailableShells false leaves catalog rows even when shells are inactive', () => {
  const prompt = fixture(coreRules).replace(
    'Available tools:\n- read: Read file contents',
    'Available tools:\n- bash: Execute a bash command\n- read: Read file contents',
  );
  const result = run(prompt, [tool('bash'), tool('read')], { activeTools: ['read'], config: { ...DEFAULT_CONFIG, pruneUnavailableShells: false } });
  assert.match(result.systemPrompt, /- bash: Execute a bash command/);
  assert.doesNotMatch(result.diagnostics.join('\n'), /shell-tools/);
});
