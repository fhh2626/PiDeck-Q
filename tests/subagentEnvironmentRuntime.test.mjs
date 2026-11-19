import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEffectiveShellPolicySnapshot, reconciliationLockPath, shellPolicySnapshotPath, SHELL_POLICY_OWNER_ENV, withReconciliationLock } from '../resources/extensions/pideck-q-subagents/src/policy/environment/childReconciliation.ts';
import { isChildSession, registerSubagentEnvironment } from '../resources/extensions/pideck-q-subagents/src/policy/environment/runtime.ts';
import { createWindowsGitDiscoveryProvider } from '../resources/extensions/pideck-q-subagents/src/policy/environment/windowsShellDiscovery.ts';

async function prepareEnvironmentDir(dir) {
  await mkdir(join(dir, 'subagents', 'environment'), { recursive: true });
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
  let registered = false;
  const originalGet = handlers.get.bind(handlers);
  handlers.get = name => {
    if (!registered) { registered = true; registerSubagentEnvironment(pi, dir, extensionOptions); }
    return originalGet(name);
  };
  const command = () => { throw new Error('Environment policy has no prompt configuration command'); };
  try { await fn({ dir, handlers, notices, ctx, command, pi }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('child role prompts do not receive parent-facing announcements', () => harness(async ({ handlers, ctx, pi }) => {
  pi._tools = [{ name: 'subagent', sourceInfo: { source: 'npm:pi-subagents' } }];
  pi._active = ['subagent'];
  const role = '<active_agent name="readonly"/>\nYou are a child agent.';
  const result = await handlers.get('before_agent_start')({ systemPrompt: role, systemPromptOptions: { customPrompt: role } }, ctx);
  assert.ok((result?.systemPrompt ?? role).includes(role));
  assert.ok(!(result?.systemPrompt ?? role).includes('Before each call to the subagent tool'));
}));

test('child process identity is recognized even without a role marker', () => {
  assert.equal(isChildSession('You are a child.', undefined, { PI_SUBAGENT_CHILD: '1' }), true);
  for (const value of [undefined, '', '0', 'false']) {
    assert.equal(isChildSession('You are a custom parent.', undefined, { PI_SUBAGENT_CHILD: value }), false);
  }
});

test('session_start hides missing Git Bash and keeps Windows PowerShell without notifying', () => harness(async ({ handlers, ctx, pi, notices }) => {
  pi._active = ['read', 'bash', 'powershell', 'edit'];
  pi.getAllTools = () => [{ name: 'bash', sourceInfo: { source: 'builtin' } }, { name: 'powershell', sourceInfo: { source: 'builtin' } }];
  await handlers.get('session_start')({}, ctx);
  assert.deepEqual(pi.getActiveTools(), ['read', 'powershell', 'edit']);
  assert.ok(
    !notices.some(x => x.includes('bash') || x.includes('shell') || x.includes('Shell')),
    `hiding bash must be silent while powershell remains, got ${JSON.stringify(notices)}`,
  );
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
    await prepareEnvironmentDir(dir);
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
    await prepareEnvironmentDir(dir);
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
    await prepareEnvironmentDir(dir);
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

test('a generic parent customPrompt is not treated as a child session', () => {
  assert.equal(isChildSession('You are a custom parent.', { customPrompt: 'You are a custom parent.' }), false);
  assert.equal(isChildSession('<active_agent name="worker"/>\n\nYou are worker.', { customPrompt: 'worker' }), true);
});

test('child shell authority obeys an explicit parent deny-all snapshot', () => harness(async ({ dir, handlers, ctx, pi }) => {
  const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
  const ownerKey = 'runtime-deny-parent';
  try {
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    await prepareEnvironmentDir(dir);
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
    await prepareEnvironmentDir(dir);
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
    await prepareEnvironmentDir(dir);
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
  await prepareEnvironmentDir(dir);
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
  await prepareEnvironmentDir(dir);
  pi._tools = [
    { name: 'read', sourceInfo: { source: 'builtin' } },
    { name: 'write', sourceInfo: { source: 'builtin' } },
    { name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0' } },
  ];
  pi._active = ['read', 'write', 'subagent'];

  // Manually pre-seed a stale snapshot that allowed 'write'
  const ownerKey = 'stale-lock-owner';
  process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
  await mkdir(join(dir, 'subagents', 'environment'), { recursive: true });
  await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
    version: 2,
    platform: 'win32',
    shell: { bash: false, powershell: false },
    parentActiveTools: ['read', 'write', 'subagent'],
  }));

  // Create an active un-stale lock file so lock acquisition fails
  const lockFile = join(dir, 'subagents', 'environment', 'reconciliation.lock');
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
    await prepareEnvironmentDir(dir);
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
      reason: '[subagent] Tool "write" was disabled or revoked by the parent session.',
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
    await prepareEnvironmentDir(dir);
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
      reason: '[subagent] Active tool APIs are unavailable. Child tool execution is blocked.',
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
  await prepareEnvironmentDir(dir);
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


}, { platform: 'win32', env: { Path: '' }, exists: () => false, isStandalone: () => false }));

test('multiple owners maintain isolated snapshots and parallel reads succeed', () => harness(async ({ dir, handlers, ctx, pi }) => {
  await prepareEnvironmentDir(dir);
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
    await prepareEnvironmentDir(dir);
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
      reason: '[subagent] Child agents cannot launch nested delegation.',
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
    await prepareEnvironmentDir(dir);
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
      reason: '[subagent] Active tool APIs are unavailable. Child tool execution is blocked.',
    });

    // Coordination tool 'contact_supervisor' is still allowed
    const coordResult = await handlers.get('tool_call')({ toolName: 'contact_supervisor', input: {} }, ctx);
    assert.equal(coordResult, undefined);
  } finally {
    if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
  }
}));

test('reconciliation lock creation window does not reclaim fresh empty lock and preserves replacement ownership', () => harness(async ({ dir }) => {
  const lockPath = reconciliationLockPath(dir);
  await mkdir(join(dir, 'subagents', 'environment'), { recursive: true });

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
  await mkdir(join(dir, 'subagents', 'environment'), { recursive: true });

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
  await mkdir(join(dir, 'subagents', 'environment'), { recursive: true });

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
  await mkdir(join(dir, 'subagents', 'environment'), { recursive: true });

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

// PiDeck 通过 PIDECK_PI_STANDALONE 声明“这是独立二进制 Pi”，不再依赖可执行文件名：
// Pi-Bolt 叫 pi-bolt(.exe)，macOS 启动器会 exec pi-bin，用户也可能改名。
test('runtime unknown shell retains active bash but does not add bash when inactive', () => {
  const host = {
    platform: 'win32',
    env: { Path: '' },
    exists: () => false,
    inspectShellPath: () => ({ kind: 'unknown', reason: 'windows-app-alias' }),
    isStandalone: () => true,
  };

  // Case 1: Active tools include read and bash -> bash is retained
  return harness(async ({ handlers, pi, command, notices }) => {
    pi._tools = [{ name: 'read' }, { name: 'bash' }];
    pi._active = ['read', 'bash'];

    await handlers.get('before_agent_start')({
      systemPrompt: 'You are Pi.',
      systemPromptOptions: {},
    }, { hasUI: true, ui: { notify: () => {} } });

    assert.deepEqual(pi.getActiveTools(), ['read', 'bash']);
  }, host).then(() => {
    // Case 2: Active tools include only read -> bash is NOT added
    return harness(async ({ handlers, pi, command, notices }) => {
      pi._tools = [{ name: 'read' }, { name: 'bash' }];
      pi._active = ['read'];

      await handlers.get('before_agent_start')({
        systemPrompt: 'You are Pi.',
        systemPromptOptions: {},
      }, { hasUI: true, ui: { notify: () => {} } });

      assert.deepEqual(pi.getActiveTools(), ['read']);
    }, host);
  });
});

test('runtime explicit missing shell prunes active bash tool', () => {
  const host = {
    platform: 'win32',
    env: { Path: '' },
    exists: () => false,
    inspectShellPath: () => ({ kind: 'missing' }),
    isStandalone: () => true,
  };

  return harness(async ({ handlers, pi, command, notices }) => {
    pi._tools = [{ name: 'read' }, { name: 'bash' }];
    pi._active = ['read', 'bash'];

    await handlers.get('before_agent_start')({
      systemPrompt: 'You are Pi.',
      systemPromptOptions: {},
    }, { hasUI: true, ui: { notify: () => {} } });

    assert.deepEqual(pi.getActiveTools(), ['read']);
  }, host, {
    windowsGitDiscovery: async () => ({ roots: [], status: 'complete' }),
  });
});

test('runtime handles rejected windowsGitDiscovery provider gracefully degrades to unknown', () => {
  const host = {
    platform: 'win32',
    env: { Path: '' },
    exists: () => false,
    inspectShellPath: () => ({ kind: 'missing' }),
    isStandalone: () => true,
  };

  return harness(async ({ handlers, pi, command, notices }) => {
    pi._tools = [{ name: 'read' }, { name: 'bash' }];
    pi._active = ['read', 'bash'];

    // Hook does not reject
    await handlers.get('before_agent_start')({
      systemPrompt: 'You are Pi.',
      systemPromptOptions: {},
    }, { hasUI: true, ui: { notify: () => {} } });

    // Discovery rejected -> bash degrades to unknown -> retained
    assert.deepEqual(pi.getActiveTools(), ['read', 'bash']);
  }, host, {
    windowsGitDiscovery: async () => { throw new Error('Registry provider failure'); },
  });
});

test('parent shell policy snapshot intersection and child ceiling constraints', () => {
  const host = {
    platform: 'win32',
    env: { Path: '' },
    exists: () => false,
    inspectShellPath: () => ({ kind: 'unknown', reason: 'windows-app-alias' }),
    isStandalone: () => true,
  };

  return harness(async ({ dir, handlers, pi, ctx }) => {
    ctx.sessionManager = { getSessionId: () => 'test-owner-snap' };
    pi._tools = [{ name: 'read' }, { name: 'bash' }];
    // Parent active is ONLY read (bash is inactive)
    pi._active = ['read'];

    await handlers.get('before_agent_start')({
      systemPrompt: 'You are Pi.',
      systemPromptOptions: {},
    }, ctx);

    // Read v2 snapshot
    const snap = readEffectiveShellPolicySnapshot(dir, 'win32', 'test-owner-snap');
    assert.ok(snap, 'Snapshot must exist');
    assert.equal(snap.version, 2);
    assert.deepEqual(snap.parentActiveTools, ['read']);
    assert.equal(snap.shell.bash, false, 'Snapshot must deny bash when parent inactive');
  }, host);
});

test('mock probeHost without windowsGitDiscovery does not trigger helper processes', async () => {
  let execFileCalls = 0;
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = () => {
    execFileCalls++;
    throw new Error('execFile should never be invoked when probeHost is provided without windowsGitDiscovery');
  };
  syncBuiltinESMExports();

  const host = {
    platform: 'win32',
    env: { Path: '' },
    exists: (file) => file === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    isExecutableFile: () => true,
    isStandalone: () => false,
  };

  try {
    await harness(async ({ handlers, pi, command, notices, ctx }) => {
      pi._tools = [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'bash', sourceInfo: { source: 'builtin' } },
        { name: 'powershell', sourceInfo: { source: 'builtin' } },
      ];
      pi._active = ['read', 'bash', 'powershell'];

      await handlers.get('before_agent_start')({
        systemPrompt: 'You are Pi.',
        systemPromptOptions: {},
      }, ctx);

      assert.equal(execFileCalls, 0, 'execFile must not be called during before_agent_start');
      assert.deepEqual(pi.getActiveTools(), ['read', 'powershell'], 'Final active tools must match mock host decisions');
    }, host, {
      locale: 'en-US',
      // Notice: windowsGitDiscovery is intentionally omitted!
    });
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  }
});

test('runtime unknown state preserves shared allowlist and ownership while policy and providers reconcile normally', async () => {
  let phase = 1;
  const host = {
    platform: 'win32',
    env: { Path: '' },
    exists: () => false,
    inspectShellPath: (file) => {
      const p = typeof file === 'string' ? file.toLowerCase() : '';
      if (p.includes('powershell')) {
        return phase === 3 ? { kind: 'missing' } : { kind: 'file' };
      }
      if (p.includes('bash')) {
        return phase === 3 ? { kind: 'file' } : { kind: 'missing' };
      }
      return { kind: 'missing' };
    },
    isExecutableFile: () => true,
    isStandalone: () => false,
  };

  const discoveryProvider = async () => {
    if (phase === 2) {
      return { roots: [], status: 'unknown' };
    }
    return { roots: [], status: 'complete' };
  };

  return harness(async ({ dir, handlers, pi, ctx }) => {
    await prepareEnvironmentDir(dir);
    ctx.sessionManager = { getSessionId: () => 'runtime-unknown-owner' };

    // Set up subagent package fixture: dir/pi-subagents/agents/worker.md
    const subagentsDir = join(dir, 'node_modules', 'pi-subagents');
    await mkdir(join(subagentsDir, 'agents'), { recursive: true });
    await writeFile(join(subagentsDir, 'index.ts'), 'export {};');
    await writeFile(join(subagentsDir, 'agents', 'worker.md'), `---
name: worker
tools: read, custom_probe
hostShell: true
---
You are worker.
`);

    const providerPath = join(dir, 'provider.ts');

    pi._tools = [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'bash', sourceInfo: { source: 'builtin' } },
      { name: 'powershell', sourceInfo: { source: 'builtin' } },
      { name: 'custom_probe', sourceInfo: { source: 'custom', path: providerPath } },
      { name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0', path: join(subagentsDir, 'index.ts') } },
    ];

    // --- Phase 1: PowerShell-only known state ---
    phase = 1;
    pi._active = ['read', 'bash', 'powershell', 'custom_probe', 'subagent'];

    await handlers.get('before_agent_start')({
      systemPrompt: 'You are Pi\n\nAvailable tools:\n- read: read\n- subagent: subagent\n',
      systemPromptOptions: {},
    }, ctx);

    const settingsPath = join(dir, 'settings.json');
    const managedMetaPath = join(dir, 'subagents', 'environment', 'managed-child-extensions.json');

    const s1 = JSON.parse(await readFile(settingsPath, 'utf8'));
    const meta1 = JSON.parse(await readFile(managedMetaPath, 'utf8'));
    const p1WorkerTools = [...s1.subagents.agentOverrides.worker.tools];

    assert.ok(p1WorkerTools.includes('powershell'), 'Phase 1: worker tools must contain powershell');
    assert.equal(p1WorkerTools.includes('bash'), false, 'Phase 1: worker tools must NOT contain bash');
    assert.deepEqual(meta1.managedTools?.worker, p1WorkerTools, 'Phase 1: managedTools.worker must match tools allowlist');

    const snap1 = readEffectiveShellPolicySnapshot(dir, 'win32', 'runtime-unknown-owner');
    assert.ok(snap1, 'Phase 1: snapshot must exist');
    assert.equal(snap1.version, 2);
    assert.equal(snap1.shell.bash, false);
    assert.equal(snap1.shell.powershell, true);
    assert.deepEqual(snap1.parentActiveTools, pi.getActiveTools());

    // --- Phase 2: Unknown state (discovery status unknown) ---
    // In Phase 2: bash becomes unknown (not missing), retention keeps it in parent,
    // but toKnownHostShells returns undefined, so shared worker tools must NOT add bash!
    phase = 2;
    await writeFile(providerPath, 'export {};'); // provider file now exists and becomes loadable
    pi._active = ['read', 'bash', 'powershell', 'custom_probe', 'subagent'];

    await handlers.get('before_agent_start')({
      systemPrompt: 'You are Pi\n\nAvailable tools:\n- read: read\n- subagent: subagent\n',
      systemPromptOptions: {},
    }, ctx);

    assert.ok(pi.getActiveTools().includes('bash'), 'Phase 2: parent active tools retains bash due to retention availability');

    const s2 = JSON.parse(await readFile(settingsPath, 'utf8'));
    const meta2 = JSON.parse(await readFile(managedMetaPath, 'utf8'));
    const p2WorkerTools = s2.subagents.agentOverrides.worker.tools;

    // Critical assertion: worker.tools MUST remain completely identical to Phase 1!
    // If runtime passed retention availability { bash: true, powershell: true } instead of
    // toKnownHostShells(details) = undefined, worker.tools would have been widened with bash!
    assert.deepEqual(p2WorkerTools, p1WorkerTools, 'Phase 2: worker.tools must NOT be widened when discovery is unknown');
    assert.deepEqual(meta2.managedTools?.worker, meta1.managedTools?.worker, 'Phase 2: managed ownership must be preserved');

    // Normal policy and provider reconciliation continues:
    const snap2 = readEffectiveShellPolicySnapshot(dir, 'win32', 'runtime-unknown-owner');
    assert.ok(snap2);
    assert.equal(snap2.version, 2);
    assert.equal(snap2.shell.bash, true, 'Phase 2: snapshot ceiling allows bash as parent retained it');
    assert.ok(snap2.parentActiveTools.includes('bash'));

    const workerExtensions = s2.subagents.agentOverrides.worker.subagentOnlyExtensions ?? [];
    assert.ok(
      workerExtensions.includes(providerPath),
      'Phase 2: provider reconciliation must still inject providerPath when unknown shell does not clobber tools',
    );

    // Non-shell tools order and content preserved
    const nonShellTools = tools => tools.filter(t => t !== 'bash' && t !== 'powershell');
    assert.deepEqual(nonShellTools(p2WorkerTools), nonShellTools(p1WorkerTools));

    // --- Phase 3: Bash-only known state ---
    phase = 3;
    pi._active = ['read', 'bash', 'powershell', 'custom_probe', 'subagent'];

    await handlers.get('before_agent_start')({
      systemPrompt: 'You are Pi\n\nAvailable tools:\n- read: read\n- subagent: subagent\n',
      systemPromptOptions: {},
    }, ctx);

    const s3 = JSON.parse(await readFile(settingsPath, 'utf8'));
    const meta3 = JSON.parse(await readFile(managedMetaPath, 'utf8'));
    const p3WorkerTools = s3.subagents.agentOverrides.worker.tools;

    assert.ok(p3WorkerTools.includes('bash'), 'Phase 3: worker.tools must now contain bash');
    assert.equal(p3WorkerTools.includes('powershell'), false, 'Phase 3: worker.tools must NOT contain powershell');
    assert.deepEqual(meta3.managedTools?.worker, p3WorkerTools, 'Phase 3: managedTools.worker must match p3WorkerTools');
    assert.deepEqual(nonShellTools(p3WorkerTools), nonShellTools(p1WorkerTools));
  }, host, {
    locale: 'en-US',
    windowsGitDiscovery: discoveryProvider,
  });
});

test('child with unknown backend shell obeys parent deny-all snapshot with unknown backend detection', () => {
  const host = {
    platform: 'win32',
    env: { Path: '' },
    exists: () => false,
    inspectShellPath: () => ({ kind: 'unknown', reason: 'windows-app-alias' }),
    isStandalone: () => false,
  };

  return harness(async ({ dir, handlers, pi, command, notices, ctx }) => {
    const ownerKey = 'child-unknown-parent-deny';
    const prevOwner = process.env[SHELL_POLICY_OWNER_ENV];
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    try {
      await prepareEnvironmentDir(dir);
      await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
        version: 2,
        platform: 'win32',
        shell: { bash: false, powershell: false },
        parentActiveTools: ['read'],
      }));

      pi._tools = [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'bash', sourceInfo: { source: 'builtin' } },
      ];
      pi._active = ['read', 'bash'];

      const prompt = '<active_agent name="worker"/>\nYou are worker.';
      const res = await handlers.get('before_agent_start')({
        systemPrompt: prompt,
        systemPromptOptions: {},
      }, ctx);

      assert.deepEqual(pi.getActiveTools(), ['read'], 'Active tools must prune bash fail-closed under parent deny');
      assert.match(res.systemPrompt, /No shell tool is available/);
      assert.doesNotMatch(res.systemPrompt, /`bash` is available/);
    } finally {
      if (prevOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
      else process.env[SHELL_POLICY_OWNER_ENV] = prevOwner;
    }
  }, host, {
    locale: 'en-US',
    windowsGitDiscovery: async () => ({ roots: [], status: 'complete' }),
  });
});

test('child without shell requirement never receives unknown bash even if parent snapshot allows it', () => {
  const host = {
    platform: 'win32',
    env: { Path: '' },
    exists: () => false,
    inspectShellPath: () => ({ kind: 'unknown', reason: 'windows-app-alias' }),
    isStandalone: () => false,
  };

  return harness(async ({ dir, handlers, pi, ctx }) => {
    const ownerKey = 'child-reader-no-shell';
    const prevOwner = process.env[SHELL_POLICY_OWNER_ENV];
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    try {
      await prepareEnvironmentDir(dir);
      await writeFile(shellPolicySnapshotPath(dir, ownerKey), JSON.stringify({
        version: 2,
        platform: 'win32',
        shell: { bash: true, powershell: false },
        parentActiveTools: ['read', 'bash'],
      }));

      // Agent fixture: reader has hostShell: false and does not want shell
      const subagentsDir = join(dir, 'node_modules', 'pi-subagents');
      await mkdir(join(subagentsDir, 'agents'), { recursive: true });
      await writeFile(join(subagentsDir, 'index.ts'), 'export {};');
      await writeFile(join(subagentsDir, 'agents', 'reader.md'), `---
name: reader
tools: read
hostShell: false
---
You are reader.
`);

      pi._tools = [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'bash', sourceInfo: { source: 'builtin' } },
        { name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0', path: join(subagentsDir, 'index.ts') } },
      ];
      pi._active = ['read']; // bash registered, but active is only read

      const prompt = '<active_agent name="reader"/>\nYou are reader.';
      await handlers.get('before_agent_start')({
        systemPrompt: prompt,
        systemPromptOptions: {},
      }, ctx);

      assert.deepEqual(pi.getActiveTools(), ['read'], 'reader must not receive bash when reader did not declare or want it');
    } finally {
      if (prevOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
      else process.env[SHELL_POLICY_OWNER_ENV] = prevOwner;
    }
  }, host, {
    locale: 'en-US',
    windowsGitDiscovery: async () => ({ roots: [], status: 'complete' }),
  });
});

test('cached discovery metadata hit still enforces fresh parent snapshot revocation in child execution gate', async () => {
  let fakeExecCalls = 0;
  const fakeNow = 1000; // never advances, within 60s TTL

  const discoveryProvider = createWindowsGitDiscoveryProvider({
    platform: 'win32',
    now: () => fakeNow,
    exec: async () => {
      fakeExecCalls++;
      return {
        stdout: JSON.stringify({ roots: ['D:\\Git'], status: 'complete' }),
        stderr: '',
      };
    },
  });

  const host = {
    platform: 'win32',
    env: { Path: '' },
    exists: () => false,
    inspectShellPath: (file) => {
      if (file === 'D:\\Git\\bin\\bash.exe') return { kind: 'file' };
      return { kind: 'missing' };
    },
    isExecutableFile: () => true,
    isStandalone: () => false,
  };

  const sharedAgentDir = await mkdtemp(join(tmpdir(), 'cached-discovery-revocation-'));
  const prevOwner = process.env[SHELL_POLICY_OWNER_ENV];
  const ownerKey = 'cached-discovery-owner';

  try {
    // Subagent package fixture
    const subagentsDir = join(sharedAgentDir, 'node_modules', 'pi-subagents');
    await mkdir(join(subagentsDir, 'agents'), { recursive: true });
    await writeFile(join(subagentsDir, 'index.ts'), 'export {};');
    await writeFile(join(subagentsDir, 'agents', 'worker.md'), `---
name: worker
tools: read, bash
hostShell: true
---
You are worker.
`);

    // 1. Parent runtime
    const parentHandlers = new Map();
    const parentPi = {
      on: (n, f) => parentHandlers.set(n, f),
      registerCommand: () => {},
      getAllTools: () => parentPi._tools,
      getActiveTools: () => parentPi._active,
      setActiveTools: (t) => { parentPi._active = [...t]; },
      _tools: [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'bash', sourceInfo: { source: 'builtin' } },
        { name: 'subagent', sourceInfo: { source: 'npm:pi-subagents@0.66.0', path: join(subagentsDir, 'index.ts') } },
      ],
      _active: ['read', 'bash', 'subagent'],
    };

    const parentCtx = {
      cwd: sharedAgentDir,
      sessionManager: { getSessionId: () => ownerKey },
      hasUI: false,
    };

    registerSubagentEnvironment(parentPi, sharedAgentDir, {
      probeHost: host,
      windowsGitDiscovery: discoveryProvider,
      isStandalone: () => false,
      locale: 'en-US',
    });

    // Parent Turn 1: enables bash, publishes snapshot
    await parentHandlers.get('before_agent_start')({
      systemPrompt: 'You are Pi\n\nAvailable tools:\n- read: read\n- subagent: subagent\n',
      systemPromptOptions: {},
    }, parentCtx);

    assert.equal(fakeExecCalls, 1, 'Initial discovery must query once');
    const snap1 = readEffectiveShellPolicySnapshot(sharedAgentDir, 'win32', ownerKey);
    assert.ok(snap1);
    assert.equal(snap1.shell.bash, true);

    // 2. Child runtime
    process.env[SHELL_POLICY_OWNER_ENV] = ownerKey;
    const childHandlers = new Map();
    const childPi = {
      on: (n, f) => childHandlers.set(n, f),
      registerCommand: () => {},
      getAllTools: () => childPi._tools,
      getActiveTools: () => childPi._active,
      setActiveTools: (t) => { childPi._active = [...t]; },
      _tools: [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'bash', sourceInfo: { source: 'builtin' } },
      ],
      _active: ['read', 'bash'],
    };

    const childCtx = { cwd: sharedAgentDir, hasUI: false };
    registerSubagentEnvironment(childPi, sharedAgentDir, {
      probeHost: host,
      windowsGitDiscovery: discoveryProvider,
      isStandalone: () => false,
      locale: 'en-US',
    });

    // Child Turn: worker agent starts
    await childHandlers.get('before_agent_start')({
      systemPrompt: '<active_agent name="worker"/>\nYou are worker.',
      systemPromptOptions: {},
    }, childCtx);

    assert.equal(childPi.getActiveTools().includes('bash'), true);

    // Initial bash tool_call in child is allowed
    const call1 = await childHandlers.get('tool_call')({
      toolName: 'bash',
      input: { command: 'echo 1' },
    }, childCtx);
    assert.equal(call1, undefined, 'Initial bash call in child must be allowed');

    // 3. Parent revokes bash (e.g. active tools becomes ['read', 'subagent'])
    parentPi._active = ['read', 'subagent'];
    await parentHandlers.get('tool_call')({
      toolName: 'subagent',
      input: { workflowScript: 'return 1;' },
    }, parentCtx);

    // Snapshot was updated to revoke bash
    const snap2 = readEffectiveShellPolicySnapshot(sharedAgentDir, 'win32', ownerKey);
    assert.ok(snap2);
    assert.equal(snap2.shell.bash, false, 'Parent snapshot must now revoke bash');
    assert.equal(snap2.parentActiveTools.includes('bash'), false);

    // 4. Child executes bash again without restarting turn
    const call2 = await childHandlers.get('tool_call')({
      toolName: 'bash',
      input: { command: 'echo 2' },
    }, childCtx);

    assert.deepEqual(call2, {
      block: true,
      reason: '[subagent] Tool "bash" was disabled or revoked by the parent session.',
    });

    // 5. Verify fakeExecCalls remained 1 throughout (discovery cache hit!)
    assert.equal(fakeExecCalls, 1, 'Discovery provider execution count must remain 1 due to TTL cache');
  } finally {
    if (prevOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
    else process.env[SHELL_POLICY_OWNER_ENV] = prevOwner;
    await rm(sharedAgentDir, { recursive: true, force: true });
  }
});

test('resuming a foreground child republishes the current parent permissions', () => harness(async ({ dir, handlers, ctx, pi }) => {
  pi._tools = ['read', 'write', 'subagent'].map(name => ({ name, sourceInfo: { source: 'builtin' } }));
  pi._active = ['read', 'write', 'subagent'];
  await handlers.get('before_agent_start')({ systemPrompt: 'You are Pi.' }, ctx);
  const owner = process.env[SHELL_POLICY_OWNER_ENV];
  assert.ok(readEffectiveShellPolicySnapshot(dir, 'linux', owner).parentActiveTools.includes('write'));
  pi._active = ['read', 'subagent'];
  const result = await handlers.get('tool_call')({ toolName: 'subagent', input: { action: 'resume', id: 'retained-run' } }, ctx);
  assert.equal(result, undefined);
  assert.deepEqual(readEffectiveShellPolicySnapshot(dir, 'linux', owner).parentActiveTools, ['read', 'subagent']);
  delete pi.getActiveTools;
  const denied = await handlers.get('tool_call')({ toolName: 'subagent', input: { action: 'resume', id: 'retained-run' } }, ctx);
  assert.equal(denied.block, true);
}, { platform: 'linux', env: {}, exists: () => true }));
