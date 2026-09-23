import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UPSTREAM_ASYNC_DEFAULT_SENTENCE } from '../config.ts';
import { DEFAULT_CONFIG } from '../defaults.ts';
import { readEffectiveShellPolicySnapshot, reconciliationLockPath, shellPolicySnapshotPath, SHELL_POLICY_OWNER_ENV, withReconciliationLock } from '../childReconciliation.ts';
import { isChildSession, registerPromptExtension } from '../runtime.ts';

async function writeConfig(dir, overrides = {}) {
  await mkdir(join(dir, 'change-pi-prompt', 'prompts'), { recursive: true });
  await writeFile(join(dir, 'change-pi-prompt/config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...overrides }));
}

async function harness(fn, host = { platform: 'win32', env: { Path: '' }, exists: () => false, isStandalone: () => true }, options = {}) {
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
  const extensionOptions = {
    probeHost: host,
    isStandalone: host.isStandalone,
    ...options,
  };
  registerPromptExtension(pi, dir, extensionOptions);
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

test('optional metadata APIs may be absent without breaking the hook and fail closed', () => harness(async ({ handlers, ctx, pi }) => {
  delete pi.getAllTools;
  delete pi.getActiveTools;
  delete pi.setActiveTools;

  // 1. Prompt transformation: when active tools APIs are missing, grep/find/bash lines must not be stripped from prompt
  const initialPrompt = 'You are Pi\n\nAvailable tools:\n- read: Read\n- grep: Search\n- find: Find files\n- bash: Shell\n- subagent: Subagent\n';
  const promptResult = await handlers.get('before_agent_start')({ systemPrompt: initialPrompt }, ctx);
  const promptText = promptResult?.systemPrompt ?? initialPrompt;
  assert.match(promptText, /- grep: Search/);
  assert.match(promptText, /- find: Find files/);

  // 2. Parent execution of subagent is blocked fail-closed
  const callResult = await handlers.get('tool_call')({
    toolName: 'subagent',
    input: { workflowScript: 'return 1;' },
  }, ctx);
  assert.deepEqual(callResult, {
    block: true,
    reason: '[change-pi-prompt] 环境缺少 getActiveTools 或 setActiveTools API，无法保证子 Agent 工具安全边界；阻断子 Agent 执行。',
  });
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

test('session_start hides grep/find when rg/fd are absent but preserves ls', () => harness(async ({ handlers, ctx, pi }) => {
  pi._active = ['read', 'grep', 'find', 'ls', 'powershell'];
  await handlers.get('session_start')({}, ctx);
  assert.deepEqual(pi.getActiveTools(), ['read', 'ls', 'powershell']);
}, {
  platform: 'win32', env: { Path: '' },
  exists: path => path.endsWith('powershell.exe'),
}));

test('child search tools obey both backend availability and the parent active-tool ceiling', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = 'runtime-search-parent';
    await writeConfig(dir);
    await writeFile(shellPolicySnapshotPath(dir, 'runtime-search-parent'), JSON.stringify({
      version: 2, platform: 'win32', shell: { bash: false, powershell: true },
      parentActiveTools: ['read', 'grep', 'find', 'ls', 'powershell'],
    }));
    pi._tools = ['read', 'grep', 'find', 'ls', 'powershell'].map(name => ({ name, sourceInfo: { source: 'builtin' } }));
    pi._active = ['read', 'grep', 'find', 'ls', 'powershell'];
    const result = await handlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="scout"/>\nUse `grep` and `find` for discovery.', systemPromptOptions: {},
    }, ctx);
    assert.deepEqual(pi.getActiveTools(), ['read', 'ls', 'powershell']);
    assert.match(result.systemPrompt, /`grep` is unavailable.*Do not call it/);
    assert.match(result.systemPrompt, /`find` is unavailable.*Do not call it/);
    assert.match(result.systemPrompt, /Select-String/);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}, {
  platform: 'win32', env: { Path: '' }, exists: path => path.endsWith('powershell.exe'),
}));

test('available rg/fd cannot widen a child beyond its parent tool set', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = 'runtime-inheritance-parent';
    await writeConfig(dir);
    await writeFile(shellPolicySnapshotPath(dir, 'runtime-inheritance-parent'), JSON.stringify({
      version: 2, platform: 'win32', shell: { bash: false, powershell: true },
      parentActiveTools: ['read', 'powershell'],
    }));
    pi._tools = ['read', 'grep', 'find', 'ls', 'powershell'].map(name => ({ name, sourceInfo: { source: 'builtin' } }));
    pi._active = ['read', 'grep', 'find', 'ls', 'powershell'];
    const result = await handlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="scout"/>\nUse `grep` and `find`.', systemPromptOptions: {},
    }, ctx);
    assert.deepEqual(pi.getActiveTools(), ['read', 'powershell']);
    assert.match(result.systemPrompt, /Active tools: read, powershell/);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}, {
  platform: 'win32', env: { Path: 'D:\\tools' },
  exists: path => path.endsWith('powershell.exe') || path === 'D:\\tools\\rg.exe' || path === 'D:\\tools\\fd.exe',
}));

test('child retains grep/find when parent enables them and both backends exist', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = 'runtime-search-allowed-parent';
    await writeConfig(dir);
    await writeFile(shellPolicySnapshotPath(dir, 'runtime-search-allowed-parent'), JSON.stringify({
      version: 2, platform: 'win32', shell: { bash: false, powershell: true },
      parentActiveTools: ['read', 'grep', 'find', 'powershell'],
    }));
    pi._tools = ['read', 'grep', 'find', 'powershell'].map(name => ({ name, sourceInfo: { source: 'builtin' } }));
    pi._active = ['read', 'grep', 'find', 'powershell'];
    const result = await handlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="scout"/>\nUse `grep` and `find`.', systemPromptOptions: {},
    }, ctx);
    assert.deepEqual(pi.getActiveTools(), ['read', 'grep', 'find', 'powershell']);
    assert.doesNotMatch(result.systemPrompt, /`grep` is unavailable|`find` is unavailable/);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}, {
  platform: 'win32', env: { Path: 'D:\\tools' },
  exists: path => path.endsWith('powershell.exe') || path === 'D:\\tools\\rg.exe' || path === 'D:\\tools\\fd.exe',
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

test('child without a usable parent snapshot fails closed to coordination tools', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  try {
    delete process.env[SHELL_POLICY_OWNER_ENV];
    await writeConfig(dir);
    pi._tools = ['read', 'grep', 'find', 'ls', 'contact_supervisor'].map(name => ({ name, sourceInfo: { source: 'builtin' } }));
    pi._active = ['read', 'grep', 'find', 'ls', 'contact_supervisor'];
    const result = await handlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="worker"/>\nUse `read` and `grep`.', systemPromptOptions: {},
    }, ctx);
    assert.deepEqual(pi.getActiveTools(), ['contact_supervisor']);
    assert.match(result.systemPrompt, /Active tools: contact_supervisor/);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}));

test('PowerShell-only Windows child does not keep bash or invent powershell', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  const ownerKey = 'runtime-prune-parent';
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
    assert.deepEqual(pi.getActiveTools(), ['read']);
    assert.equal(pi.getAllTools().some(tool => tool.name === 'powershell'), false);
    assert.match(result.systemPrompt, /No shell tool is available/);
    assert.doesNotMatch(result.systemPrompt, /executes PowerShell, not GNU Bash/);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}, {
  platform: 'win32',
  env: { Path: '' },
  exists: path => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
}));

test('parent dynamic tool revocation narrows published snapshot on subagent call', () => harness(async ({ dir, handlers, ctx, pi }) => {
  await writeConfig(dir);
  pi._tools = [
    { name: 'read', sourceInfo: { source: 'builtin' } },
    { name: 'write', sourceInfo: { source: 'builtin' } },
    { name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0' } },
  ];
  pi._active = ['read', 'write', 'subagent'];
  const sessionPrompt = 'You are Pi\n\nAvailable tools:\n- subagent: subagent\n- read: read\n- write: write\n';
  await handlers.get('before_agent_start')({ systemPrompt: sessionPrompt }, ctx);

  const ownerKey = process.env[SHELL_POLICY_OWNER_ENV];
  assert.ok(ownerKey, 'owner key should be set');
  const snap1 = JSON.parse(await readFile(shellPolicySnapshotPath(dir, ownerKey), 'utf8'));
  assert.ok(snap1.parentActiveTools.includes('write'));

  // Parent active tools change dynamically (write revoked)
  pi._active = ['read', 'subagent'];
  await handlers.get('tool_call')({
    toolName: 'subagent',
    input: { workflowScript: 'return 1;' },
  }, ctx);

  const snap2 = JSON.parse(await readFile(shellPolicySnapshotPath(dir, ownerKey), 'utf8'));
  assert.equal(snap2.parentActiveTools.includes('write'), false);
  assert.deepEqual(snap2.parentActiveTools, ['read', 'subagent']);
}, { platform: 'win32', env: { Path: '' }, exists: () => false, isStandalone: () => false }));

test('lock acquisition failure blocks subagent execution even if stale snapshot exists', () => harness(async ({ dir, handlers, ctx, pi }) => {
  await writeConfig(dir);
  pi._tools = [
    { name: 'read', sourceInfo: { source: 'builtin' } },
    { name: 'write', sourceInfo: { source: 'builtin' } },
    { name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0' } },
  ];
  pi._active = ['read', 'write', 'subagent'];

  // Manually pre-seed a stale snapshot that allowed 'write'
  const ownerKey = 'stale-lock-owner';
  process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
  await mkdir(join(dir, 'change-pi-prompt'), { recursive: true });
  await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
    version: 2,
    platform: 'win32',
    shell: { bash: false, powershell: false },
    parentActiveTools: ['read', 'write', 'subagent'],
  }));

  // Create an active un-stale lock file so lock acquisition fails
  const lockFile = join(dir, 'change-pi-prompt', 'reconciliation.lock');
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

  const result = await handlers.get('tool_call')({
    toolName: 'subagent',
    input: { workflowScript: 'return 1;' },
  }, ctx);

  assert.ok(result?.block, 'subagent execution should be blocked on lock failure');
  assert.match(result.reason, /reconciliation lock unavailable/);
}, { platform: 'win32', env: { Path: '' }, exists: () => false, isStandalone: () => false }, {
  lock: { timeoutMs: 0, retryMs: 1 },
}));

test('running child secondary gate enforces fresh revocation from parent snapshot', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const ownerKey = 'running-child-owner';
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    await writeConfig(dir);
    await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
      version: 2,
      platform: 'win32',
      shell: { bash: false, powershell: false },
      parentActiveTools: ['read', 'write'],
    }));

    pi._tools = [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'write', sourceInfo: { source: 'builtin' } },
    ];
    pi._active = ['read', 'write'];

    // Child starts turn
    await handlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="worker"/>\nYou are worker.',
      systemPromptOptions: {},
    }, ctx);

    // Initial check: read and write are both allowed
    assert.equal(await handlers.get('tool_call')({ toolName: 'read', input: { path: 'a.txt' } }, ctx), undefined);
    assert.equal(await handlers.get('tool_call')({ toolName: 'write', input: { path: 'a.txt' } }, ctx), undefined);

    // Parent updates snapshot to revoke write
    await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
      version: 2,
      platform: 'win32',
      shell: { bash: false, powershell: false },
      parentActiveTools: ['read'],
    }));

    // Next tool_call for write is blocked
    const writeResult = await handlers.get('tool_call')({ toolName: 'write', input: { path: 'a.txt' } }, ctx);
    assert.deepEqual(writeResult, {
      block: true,
      reason: '[change-pi-prompt] 工具 "write" 已被父会话撤销或未被父会话启用。',
    });

    // Still permitted read is not blocked
    assert.equal(await handlers.get('tool_call')({ toolName: 'read', input: { path: 'a.txt' } }, ctx), undefined);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}, { platform: 'win32', env: { Path: '' }, exists: () => false, isStandalone: () => false }));

test('missing child setActiveTools blocks child tool execution fail-closed', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const ownerKey = 'child-missing-api-owner';
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    await writeConfig(dir);
    await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
      version: 2,
      platform: 'win32',
      shell: { bash: false, powershell: false },
      parentActiveTools: ['read'],
    }));

    pi._tools = [{ name: 'read', sourceInfo: { source: 'builtin' } }, { name: 'contact_supervisor' }];
    pi._active = ['read', 'contact_supervisor'];

    // Child starts turn
    await handlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="worker"/>\nYou are worker.',
      systemPromptOptions: {},
    }, ctx);

    // Delete setActiveTools on child
    delete pi.setActiveTools;

    // Ordinary tool 'read' is blocked
    const result = await handlers.get('tool_call')({ toolName: 'read', input: { path: 'a.txt' } }, ctx);
    assert.deepEqual(result, {
      block: true,
      reason: '[change-pi-prompt] 环境缺少 getActiveTools 或 setActiveTools API，无法保证子 Agent 工具安全边界；阻断普通工具调用。',
    });

    // Coordination tool 'contact_supervisor' is still allowed
    const coordResult = await handlers.get('tool_call')({ toolName: 'contact_supervisor', input: {} }, ctx);
    assert.equal(coordResult, undefined);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}));

test('inline workflowScript without agent passes parent snapshot gate, status action bypasses it', () => harness(async ({ dir, handlers, ctx, pi }) => {
  await writeConfig(dir);
  pi._tools = [
    { name: 'read', sourceInfo: { source: 'builtin' } },
    { name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0' } },
  ];
  pi._active = ['read', 'subagent'];

  // Management call: action: 'status' returns without error and does not reconcile/block
  const statusResult = await handlers.get('tool_call')({
    toolName: 'subagent',
    input: { action: 'status' },
  }, ctx);
  assert.equal(statusResult, undefined);

  // Execution call: inline workflowScript passes snapshot gate and publishes snapshot
  const execResult = await handlers.get('tool_call')({
    toolName: 'subagent',
    input: { workflowScript: 'return 1;' },
  }, ctx);
  assert.equal(execResult, undefined);

  const ownerKey = process.env[SHELL_POLICY_OWNER_ENV];
  const snap = JSON.parse(await readFile(shellPolicySnapshotPath(dir, ownerKey), 'utf8'));
  assert.deepEqual(snap.parentActiveTools, ['read', 'subagent']);

  // Malformed management action with task is blocked
  const malformed = await handlers.get('tool_call')({
    toolName: 'subagent',
    input: { action: 'list', task: 'do work' },
  }, ctx);
  assert.deepEqual(malformed, {
    block: true,
    reason: '[change-pi-prompt] 参数错误：action 不能与 task 混用。',
  });
}, { platform: 'win32', env: { Path: '' }, exists: () => false, isStandalone: () => false }));

test('multiple owners maintain isolated snapshots and parallel reads succeed', () => harness(async ({ dir, handlers, ctx, pi }) => {
  await writeConfig(dir);
  const ownerA = 'owner-session-a';
  const ownerB = 'owner-session-b';

  await writeFile(shellPolicySnapshotPath(dir, ownerA), JSON.stringify({
    version: 2, platform: 'win32', shell: { bash: false, powershell: false },
    parentActiveTools: ['read', 'write'],
  }));
  await writeFile(shellPolicySnapshotPath(dir, ownerB), JSON.stringify({
    version: 2, platform: 'win32', shell: { bash: false, powershell: false },
    parentActiveTools: ['read'],
  }));

  const snapA = readEffectiveShellPolicySnapshot(dir, 'win32', ownerA);
  const snapB = readEffectiveShellPolicySnapshot(dir, 'win32', ownerB);

  assert.deepEqual(snapA.parentActiveTools, ['read', 'write']);
  assert.deepEqual(snapB.parentActiveTools, ['read']);

  // Parallel reads to the same snapshot file succeed without error
  const parallelReads = await Promise.all([
    readEffectiveShellPolicySnapshot(dir, 'win32', ownerA),
    readEffectiveShellPolicySnapshot(dir, 'win32', ownerA),
    readEffectiveShellPolicySnapshot(dir, 'win32', ownerA),
  ]);
  assert.equal(parallelReads.length, 3);
  for (const read of parallelReads) {
    assert.deepEqual(read.parentActiveTools, ['read', 'write']);
  }
}));

test('child executing nested subagent is blocked', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const ownerKey = 'child-nested-owner';
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    await writeConfig(dir);
    await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
      version: 2, platform: 'win32', shell: { bash: false, powershell: false },
      parentActiveTools: ['subagent'],
    }));

    pi._tools = [{ name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0' } }];
    pi._active = ['subagent'];

    // Child session starts
    await handlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="worker"/>\nYou are worker.',
      systemPromptOptions: {},
    }, ctx);

    // Child tries to execute nested subagent -> blocked!
    const nestedResult = await handlers.get('tool_call')({
      toolName: 'subagent',
      input: { agent: 'helper', task: 'do nested work' },
    }, ctx);
    assert.deepEqual(nestedResult, {
      block: true,
      reason: '[change-pi-prompt] 子 Agent 不支持发起到下一级子 Agent 的执行型委派。',
    });

    // Child executing pure management action -> allowed
    const manageResult = await handlers.get('tool_call')({
      toolName: 'subagent',
      input: { action: 'list' },
    }, ctx);
    assert.equal(manageResult, undefined);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}));

test('missing child getActiveTools blocks child tool execution fail-closed', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const ownerKey = 'child-missing-get-api-owner';
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    await writeConfig(dir);
    await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
      version: 2,
      platform: 'win32',
      shell: { bash: false, powershell: false },
      parentActiveTools: ['read'],
    }));

    pi._tools = [{ name: 'read', sourceInfo: { source: 'builtin' } }, { name: 'contact_supervisor' }];
    pi._active = ['read', 'contact_supervisor'];

    // Delete getActiveTools BEFORE child starts turn
    delete pi.getActiveTools;

    await handlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="worker"/>\nYou are worker.',
      systemPromptOptions: {},
    }, ctx);

    // Ordinary tool 'read' is blocked fail-closed
    const result = await handlers.get('tool_call')({ toolName: 'read', input: { path: 'a.txt' } }, ctx);
    assert.deepEqual(result, {
      block: true,
      reason: '[change-pi-prompt] 环境缺少 getActiveTools 或 setActiveTools API，无法保证子 Agent 工具安全边界；阻断普通工具调用。',
    });

    // Coordination tool 'contact_supervisor' is still allowed
    const coordResult = await handlers.get('tool_call')({ toolName: 'contact_supervisor', input: {} }, ctx);
    assert.equal(coordResult, undefined);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}));

test('parent and child schedule execution actions are blocked while safe schedule management passes', () => harness(async ({ dir, handlers, ctx, pi }) => {
  await writeConfig(dir);
  pi._tools = [
    { name: 'read', sourceInfo: { source: 'builtin' } },
    { name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0' } },
  ];
  pi._active = ['read', 'subagent'];

  const sessionPrompt = 'You are Pi\n\nAvailable tools:\n- subagent: subagent\n- read: read\n';
  await handlers.get('before_agent_start')({ systemPrompt: sessionPrompt }, ctx);

  // 1. Parent session: safe management actions pass
  for (const safeAction of ['schedule.list', 'schedule.show', 'schedule.history', 'schedule.pause', 'schedule.delete']) {
    const res = await handlers.get('tool_call')({
      toolName: 'subagent',
      input: { action: safeAction, id: 'sched-1' },
    }, ctx);
    assert.equal(res, undefined, `Parent ${safeAction} should pass as management`);
  }

  // 2. Parent session: execution actions schedule.run, schedule.run-due, schedule.resume, schedule.create are blocked
  for (const execAction of ['schedule.run', 'schedule.run-due', 'schedule.resume', 'schedule.create']) {
    const res = await handlers.get('tool_call')({
      toolName: 'subagent',
      input: { action: execAction, id: 'sched-1' },
    }, ctx);
    assert.ok(res?.block, `Parent ${execAction} must be blocked`);
    assert.equal(res.reason, `[change-pi-prompt] 安全限制：不支持通过 "${execAction}" 触发或恢复计划任务执行。`);
  }

  // 3. Child session: starts turn
  const ownerKey = process.env[SHELL_POLICY_OWNER_ENV];
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  try {
    await handlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="worker"/>\nYou are worker.',
      systemPromptOptions: {},
    }, ctx);

    // Child executing safe management actions pass
    const childList = await handlers.get('tool_call')({
      toolName: 'subagent',
      input: { action: 'schedule.list' },
    }, ctx);
    assert.equal(childList, undefined);

    // Child executing schedule execution actions are blocked as nested delegation
    for (const execAction of ['schedule.run', 'schedule.run-due', 'schedule.resume', 'schedule.create']) {
      const childRes = await handlers.get('tool_call')({
        toolName: 'subagent',
        input: { action: execAction, id: 'sched-1' },
      }, ctx);
      assert.deepEqual(childRes, {
        block: true,
        reason: '[change-pi-prompt] 子 Agent 不支持发起到下一级子 Agent 的执行型委派。',
      }, `Child ${execAction} must be blocked as nested execution`);
    }
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}, { platform: 'win32', env: { Path: '' }, exists: () => false, isStandalone: () => false }));

test('reconciliation lock creation window does not reclaim fresh empty lock and preserves replacement ownership', () => harness(async ({ dir }) => {
  const lockPath = reconciliationLockPath(dir);
  await mkdir(join(dir, 'change-pi-prompt'), { recursive: true });

  // 1. Fresh empty lock: created just now (mtime fresh, 0 bytes)
  await writeFile(lockPath, '');
  let ranOnFresh = false;
  const freshRes = await withReconciliationLock(dir, () => { ranOnFresh = true; }, {
    timeoutMs: 80,
    retryMs: 20,
    staleMs: 5000,
  });
  assert.equal(freshRes, undefined, 'A fresh empty lock must not be acquired');
  assert.equal(ranOnFresh, false, 'Callback must not run while fresh empty lock exists');
  const existsAfterFresh = await readFile(lockPath, 'utf8').then(() => true, () => false);
  assert.equal(existsAfterFresh, true, 'Fresh empty lock must NOT be deleted as stale');

  // 2. Stale empty lock: simulated by setting old timestamp in parsed JSON or old stat
  // Clean up fresh lock
  await rm(lockPath, { force: true });

  // 3. Ownership preservation: if lock file is replaced with another token during fn(), finally does NOT delete it
  let insideRan = false;
  await withReconciliationLock(dir, async () => {
    insideRan = true;
    // Overwrite lock with another owner's token
    await writeFile(lockPath, JSON.stringify({ pid: 12345, createdAt: Date.now(), token: 'foreign-token' }));
  });
  assert.equal(insideRan, true);
  const foreignLockStillExists = await readFile(lockPath, 'utf8').then(text => text.includes('foreign-token'), () => false);
  assert.equal(foreignLockStillExists, true, 'Finally must NOT delete a lock file replaced by another owner');
}));

test('stale parseable lock without valid numeric createdAt is reclaimed', () => harness(async ({ dir }) => {
  const lockPath = reconciliationLockPath(dir);
  await mkdir(join(dir, 'change-pi-prompt'), { recursive: true });

  // Case 1: lock file contains '{}'
  await writeFile(lockPath, '{}');
  let calledEmptyObj = false;
  const resEmptyObj = await withReconciliationLock(dir, () => {
    calledEmptyObj = true;
    return 'acquired-empty-obj';
  }, {
    timeoutMs: 0,
    staleMs: 30_000,
    now: () => Date.now() + 120_000,
  });
  assert.equal(calledEmptyObj, true, 'Callback must run after reclaiming stale {} lock');
  assert.equal(resEmptyObj, 'acquired-empty-obj');
  const existsAfterEmptyObj = await readFile(lockPath, 'utf8').then(() => true, () => false);
  assert.equal(existsAfterEmptyObj, false, 'Lock must be cleaned up after successful acquisition and run');

  // Case 2: lock file contains invalid string createdAt
  await writeFile(lockPath, JSON.stringify({ pid: 1, createdAt: 'invalid' }));
  let calledInvalidCreatedAt = false;
  const resInvalid = await withReconciliationLock(dir, () => {
    calledInvalidCreatedAt = true;
    return 'acquired-invalid-createdAt';
  }, {
    timeoutMs: 0,
    staleMs: 30_000,
    now: () => Date.now() + 120_000,
  });
  assert.equal(calledInvalidCreatedAt, true, 'Callback must run after reclaiming stale invalid createdAt lock');
  assert.equal(resInvalid, 'acquired-invalid-createdAt');
}));

test('fresh parseable lock without createdAt is NOT reclaimed', () => harness(async ({ dir }) => {
  const lockPath = reconciliationLockPath(dir);
  await mkdir(join(dir, 'change-pi-prompt'), { recursive: true });

  // Newly written '{}' is fresh (age 0 <= staleMs)
  await writeFile(lockPath, '{}');
  let called = false;
  const res = await withReconciliationLock(dir, () => {
    called = true;
    return 'acquired';
  }, {
    timeoutMs: 0,
    staleMs: 30_000,
  });
  assert.equal(called, false, 'Callback must not run when fresh {} lock is present');
  assert.equal(res, undefined, 'withReconciliationLock must return undefined on held fresh lock');
  const exists = await readFile(lockPath, 'utf8').then(() => true, () => false);
  assert.equal(exists, true, 'Fresh {} lock must not be deleted');
}));

test('legacy lock with numeric createdAt is reclaimed when stale and preserved when fresh', () => harness(async ({ dir }) => {
  const lockPath = reconciliationLockPath(dir);
  await mkdir(join(dir, 'change-pi-prompt'), { recursive: true });

  // 1. Fresh legacy lock: createdAt = Date.now()
  await writeFile(lockPath, JSON.stringify({ pid: 1234, createdAt: Date.now() }));
  let freshCalled = false;
  const freshRes = await withReconciliationLock(dir, () => {
    freshCalled = true;
    return 'acquired';
  }, {
    timeoutMs: 0,
    staleMs: 30_000,
  });
  assert.equal(freshCalled, false, 'Fresh legacy lock must not be reclaimed');
  assert.equal(freshRes, undefined);

  // 2. Stale legacy lock: createdAt is 60s ago
  await writeFile(lockPath, JSON.stringify({ pid: 1234, createdAt: Date.now() - 60_000 }));
  let staleCalled = false;
  const staleRes = await withReconciliationLock(dir, () => {
    staleCalled = true;
    return 'acquired-stale-legacy';
  }, {
    timeoutMs: 0,
    staleMs: 30_000,
  });
  assert.equal(staleCalled, true, 'Stale legacy lock must be reclaimed');
  assert.equal(staleRes, 'acquired-stale-legacy');
}));