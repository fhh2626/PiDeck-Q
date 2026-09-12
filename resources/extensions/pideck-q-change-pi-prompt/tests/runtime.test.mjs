import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UPSTREAM_ASYNC_DEFAULT_SENTENCE } from '../config.ts';
import { DEFAULT_CONFIG } from '../defaults.ts';
import { shellPolicySnapshotPath, SHELL_POLICY_OWNER_ENV } from '../childReconciliation.ts';
import { isChildSession, registerPromptExtension } from '../runtime.ts';

async function writeConfig(dir, overrides = {}) {
  await mkdir(join(dir, 'change-pi-prompt'), { recursive: true });
  await writeFile(join(dir, 'change-pi-prompt/config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...overrides }));
}

async function harness(fn, host = { platform: 'win32', env: { Path: '' }, exists: () => false, isStandalone: () => true }) {
  const dir = await mkdtemp(join(tmpdir(), 'change-pi-runtime-'));
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const ctx = { cwd: dir, hasUI: true, ui: { notify: message => notices.push(message), editor: async () => undefined } };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    getAllTools: () => pi._tools ?? [],
    getActiveTools: () => pi._active ?? [],
    setActiveTools: names => { pi._active = [...names]; },
    registerTool: tool => {
      const tools = [...(pi._tools ?? [])];
      const index = tools.findIndex(candidate => candidate.name === tool.name);
      if (index >= 0) tools[index] = tool;
      else tools.push(tool);
      pi._tools = tools;
    },
    _tools: [],
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

test('before_agent_start auto-provisions foreground-safe config when absent and warns if unsafe', () => harness(async ({ dir, handlers, notices, ctx, pi }) => {
  await writeConfig(dir);
  pi.getAllTools = () => [{ name: 'subagent', sourceInfo: { source: 'npm:pi-subagents' } }];
  pi.getActiveTools = () => ['subagent'];
  const prompt = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n- subagent: Delegate\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n- Be concise in your responses\n\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md\n- Additional docs: /pi/docs\n- Examples: /pi/examples\n';
  await handlers.get('session_start')({}, ctx);
  await handlers.get('before_agent_start')({ systemPrompt: prompt, systemPromptOptions: { selectedTools: ['subagent'] } }, ctx);
  assert.equal(notices.some(x => x.includes('asyncByDefault')), false);
  const created = JSON.parse(await readFile(join(dir, 'extensions/subagent/config.json'), 'utf8'));
  assert.deepEqual(created, { asyncByDefault: false, forceTopLevelAsync: false });

  notices.length = 0;
  await writeFile(join(dir, 'extensions/subagent/config.json'), '{"asyncByDefault":true}');
  await handlers.get('before_agent_start')({ systemPrompt: prompt, systemPromptOptions: { selectedTools: ['subagent'] } }, ctx);
  assert.ok(notices.some(x => x.includes('asyncByDefault')));

  notices.length = 0;
  await writeFile(join(dir, 'extensions/subagent/config.json'), '{"asyncByDefault":false}');
  await handlers.get('before_agent_start')({ systemPrompt: prompt, systemPromptOptions: { selectedTools: ['subagent'] } }, ctx);
  assert.equal(notices.some(x => x.includes('asyncByDefault')), false);
}));

test('before_provider_request rewrites tool descriptions in the payload', () => harness(async ({ handlers, ctx }) => {
  await handlers.get('session_start')({}, ctx);
  const payload = { tools: [{ function: { name: 'subagent', description: UPSTREAM_ASYNC_DEFAULT_SENTENCE } }] };
  const next = handlers.get('before_provider_request')({ payload });
  assert.match(JSON.stringify(next), /asyncByDefault:true/);
  assert.equal(JSON.stringify(next).includes(UPSTREAM_ASYNC_DEFAULT_SENTENCE), false);
}));

test('context rewrites skill messages that recommend background children', () => harness(async ({ handlers, ctx }) => {
  await handlers.get('session_start')({}, ctx);
  const next = handlers.get('context')({ messages: [{ role: 'user', content: 'Use async/background by default. Set `async:false` only when the parent must\nblock. Final reviews, validation gates, oracle checks, and publication checks\nstay async.' }] });
  assert.match(JSON.stringify(next.messages), /This environment requires `async:false`/);
  assert.doesNotMatch(JSON.stringify(next.messages), /Use async\/background by default/);
}));

test('tool_result rewrites only pi-subagents skill reads', () => harness(async ({ handlers, ctx }) => {
  await handlers.get('session_start')({}, ctx);
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

test('a generic parent customPrompt is not treated as a child session', () => {
  assert.equal(isChildSession('You are a custom parent.', { customPrompt: 'You are a custom parent.' }), false);
  assert.equal(isChildSession('<active_agent name="worker"/>\n\nYou are worker.', { customPrompt: 'worker' }), true);
});

test('subagent=false leaves child before_agent_start prompt and active tools untouched', () => harness(async ({ dir, handlers, ctx, pi }) => {
  await writeConfig(dir, { subagent: false });
  pi._tools = [
    { name: 'read', sourceInfo: { source: 'builtin' } },
    { name: 'bash', sourceInfo: { source: 'builtin' } },
  ];
  pi._active = ['read', 'bash'];
  const prompt = '<active_agent name="worker"/>\n\nYou are worker. Use `bash` for validation.';
  const result = await handlers.get('before_agent_start')({ systemPrompt: prompt, systemPromptOptions: {} }, ctx);
  assert.equal(result, undefined);
  assert.deepEqual(pi.getActiveTools(), ['read', 'bash']);
}));

test('child shell authority obeys an explicit parent deny-all snapshot', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  const ownerKey = 'runtime-deny-parent';
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    await writeConfig(dir);
    await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
      version: 2,
      platform: 'win32',
      shell: { bash: false, powershell: false },
      parentActiveTools: ['read'],
    }));
    pi._tools = [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'bash', sourceInfo: { source: 'builtin' } },
      { name: 'powershell', sourceInfo: { source: 'builtin' } },
    ];
    pi._active = ['read', 'bash', 'powershell'];
    const prompt = '<active_agent name="worker"/>\n\nYou are worker. Use `bash` for validation.';
    const result = await handlers.get('before_agent_start')({ systemPrompt: prompt, systemPromptOptions: {} }, ctx);
    assert.deepEqual(pi.getActiveTools(), ['read']);
    assert.match(result.systemPrompt, /No shell tool is available/);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}, {
  platform: 'win32',
  env: { Path: '' },
  exists: path => path.endsWith('bash.exe') || path.endsWith('powershell.exe'),
}));

test('PowerShell-only Windows child uses the historical bash allowlist slot end-to-end', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  const ownerKey = 'runtime-bridge-parent';
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    await writeConfig(dir);
    await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
      version: 2,
      platform: 'win32',
      shell: { bash: false, powershell: true },
      parentActiveTools: ['read', 'powershell'],
    }));
    pi._tools = [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'bash', sourceInfo: { source: 'builtin' } },
    ];
    pi._active = ['read', 'bash'];
    const prompt = '<active_agent name="worker"/>\n\nYou are worker. Use `bash` for validation.';
    const result = await handlers.get('before_agent_start')({ systemPrompt: prompt, systemPromptOptions: {} }, ctx);
    assert.deepEqual(pi.getActiveTools(), ['read', 'bash']);
    assert.equal(pi.getAllTools().some(tool => tool.name === 'powershell'), false);
    assert.match(result.systemPrompt, /executes PowerShell, not GNU Bash/);
    assert.match(result.systemPrompt, /`bash` is available/);
    assert.match(result.systemPrompt, /`powershell` is unavailable/);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}, {
  platform: 'win32',
  env: { Path: '' },
  exists: path => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
}));