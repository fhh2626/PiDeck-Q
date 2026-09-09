import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UPSTREAM_ASYNC_DEFAULT_SENTENCE } from '../config.ts';
import { registerPromptExtension } from '../runtime.ts';

async function harness(fn, host = { platform: 'win32', env: { Path: '' }, exists: () => false }) {
  const dir = await mkdtemp(join(tmpdir(), 'change-pi-runtime-'));
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const ctx = { hasUI: true, ui: { notify: message => notices.push(message), editor: async () => undefined } };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    getAllTools: () => [],
    getActiveTools: () => pi._active ?? [],
    setActiveTools: names => { pi._active = [...names]; },
    _active: [],
  };
  registerPromptExtension(pi, dir, host);
  const command = arg => commands.get('change-pi-prompt').handler(arg, ctx);
  try { await fn({ dir, handlers, notices, ctx, command, pi }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('init-subagent without package is a safe no-op', () => harness(async ({ dir, command, notices }) => {
  await command('init-subagent');
  await assert.rejects(readFile(join(dir, 'subagent-tool-description.md')), { code: 'ENOENT' });
  assert.ok(notices.some(x => x.includes('未检测到')));
}));
test('init-subagent recognizes native custom-mode tools and points at native config', () => harness(async ({ dir, command, notices, pi }) => {
  pi.getAllTools = () => [{ name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0' } }];
  await command('init-subagent');
  assert.match(await readFile(join(dir, 'subagent-tool-description.md'), 'utf8'), /runs\.all/);
  assert.ok(notices.some(x => x.includes(join(dir, 'extensions', 'subagent', 'config.json')) && x.includes('custom')));
  await assert.rejects(readFile(join(dir, 'extensions/subagent/config.json')), { code: 'ENOENT' });
  await writeFile(join(dir, 'subagent-tool-description.md'), 'USER CONTENT');
  await command('init-subagent');
  assert.equal(await readFile(join(dir, 'subagent-tool-description.md'), 'utf8'), 'USER CONTENT');
}));
test('before_agent_start warns unless native asyncByDefault is false', () => harness(async ({ dir, handlers, notices, ctx, pi }) => {
  await mkdir(join(dir, 'change-pi-prompt'), { recursive: true });
  await writeFile(join(dir, 'change-pi-prompt/config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, replaceIdentity: true, replaceGuidelines: true, removeDocumentation: true, pwsh: true, subagent: true, unknownGuidelines: 'preserve' }));
  pi.getAllTools = () => [{ name: 'subagent', sourceInfo: { source: 'npm:pi-subagents' } }];
  pi.getActiveTools = () => ['subagent'];
  const prompt = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n- subagent: Delegate\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n- Be concise in your responses\n\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md\n- Additional docs: /pi/docs\n- Examples: /pi/examples\n';
  await handlers.get('session_start')({}, ctx);
  await handlers.get('before_agent_start')({ systemPrompt: prompt, systemPromptOptions: { selectedTools: ['subagent'] } }, ctx);
  assert.ok(notices.some(x => x.includes('asyncByDefault')));
  notices.length = 0;
  await mkdir(join(dir, 'extensions/subagent'), { recursive: true });
  await writeFile(join(dir, 'extensions/subagent/config.json'), '{"asyncByDefault":false}');
  await handlers.get('before_agent_start')({ systemPrompt: prompt, systemPromptOptions: { selectedTools: ['subagent'] } }, ctx);
  assert.equal(notices.some(x => x.includes('asyncByDefault')), false);
}));
test('before_provider_request rewrites tool descriptions in the payload', () => harness(async ({ handlers }) => {
  const payload = { tools: [{ function: { name: 'subagent', description: UPSTREAM_ASYNC_DEFAULT_SENTENCE } }] };
  const next = handlers.get('before_provider_request')({ payload });
  assert.match(JSON.stringify(next), /asyncByDefault:true/);
  assert.equal(JSON.stringify(next).includes(UPSTREAM_ASYNC_DEFAULT_SENTENCE), false);
}));
test('context rewrites skill messages that recommend background children', () => harness(async ({ handlers }) => {
  const next = handlers.get('context')({ messages: [{ role: 'user', content: 'Use async/background by default. Set `async:false` only when the parent must\nblock. Final reviews, validation gates, oracle checks, and publication checks\nstay async.' }] });
  assert.match(JSON.stringify(next.messages), /This environment requires `async:false`/);
  assert.doesNotMatch(JSON.stringify(next.messages), /Use async\/background by default/);
}));
test('tool_result rewrites only pi-subagents skill reads', () => harness(async ({ handlers }) => {
  const content = [{ type: 'text', text: 'Use async/background by default. Final reviews and gate checks stay async.' }];
  const skill = handlers.get('tool_result')({ toolName: 'read', isError: false, input: { path: 'C:\\npm\\node_modules\\pi-subagents\\skills\\pi-subagents\\SKILL.md' }, content });
  assert.match(JSON.stringify(skill.content), /This environment requires `async:false`/);
  assert.doesNotMatch(JSON.stringify(skill.content), /Use async\/background by default/);
  const other = handlers.get('tool_result')({ toolName: 'read', isError: false, input: { path: 'C:\\project\\README.md' }, content });
  assert.equal(other, undefined);
}));
test('optional metadata APIs may be absent without breaking the hook', () => harness(async ({ handlers, ctx, pi }) => {
  delete pi.getAllTools;
  delete pi.getActiveTools;
  assert.equal(await handlers.get('before_agent_start')({ systemPrompt: 'CUSTOM' }, ctx), undefined);
}));
test('failed reload retains last-good settings and reports error', () => harness(async ({ dir, command, notices }) => {
  await command('init');
  await command('reload');
  await writeFile(join(dir, 'change-pi-prompt/config.json'), '{"enabled":"false"}');
  await command('reload');
  await command('status');
  assert.ok(notices.some(x => x.includes('命令失败')));
  assert.ok(notices.at(-1).includes('有效配置：已加载'));
}));
test('session_start hides missing Git Bash and keeps Windows PowerShell', () => harness(async ({ handlers, ctx, pi, notices }) => {
  pi._active = ['read', 'bash', 'powershell', 'edit'];
  pi.getAllTools = () => [{ name: 'bash', sourceInfo: { source: 'builtin' } }, { name: 'powershell', sourceInfo: { source: 'builtin' } }];
  await handlers.get('session_start')({}, ctx);
  assert.deepEqual(pi.getActiveTools(), ['read', 'powershell', 'edit']);
  assert.ok(notices.some(x => x.includes('bash') && x.includes('隐藏')));
}, {
  platform: 'win32',
  env: { Path: '' },
  exists: path => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
}));
test('pwsh-adapter bash is not hidden when Git Bash is missing', () => harness(async ({ handlers, ctx, pi }) => {
  pi._active = ['bash'];
  pi.getAllTools = () => [{ name: 'bash', sourceInfo: { source: 'npm:@99percentpeople/pi-pwsh-adapter' } }];
  await handlers.get('session_start')({}, ctx);
  assert.deepEqual(pi.getActiveTools(), ['bash']);
}));
