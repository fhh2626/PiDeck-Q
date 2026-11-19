import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import './helpers/piFixtureResolver.mjs';

const { createChildHooks } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-hooks.ts');
const { registerSubagentEnvironment } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/runtime.ts');
const { reconcileChildEnvironments, readEffectiveShellPolicySnapshot, shellPolicySnapshotPath, SHELL_POLICY_OWNER_ENV } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/childReconciliation.ts');

function host(names, sessionId = 'parent-a') {
  const handlers = new Map();
  let active = [...names];
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getAllTools: () => names.map(name => ({ name, sourceInfo: { source: 'builtin' } })),
    getActiveTools: () => [...active],
    setActiveTools(next) { active = [...next]; },
    events: { on() { return () => {}; }, emit() {} },
    registerTool() {},
  };
  const ctx = { hasUI: true, ui: { notify() {} }, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => null } };
  return {
    pi, ctx,
    async emit(name, event) {
      let result;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next?.block) return next;
        if (next?.systemPrompt) event = { ...event, systemPrompt: next.systemPrompt };
        if (next) result = next;
      }
      return result;
    },
  };
}

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-owner-'));
  const prior = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, [SHELL_POLICY_OWNER_ENV]: process.env[SHELL_POLICY_OWNER_ENV] };
  process.env.PI_CODING_AGENT_DIR = dir;
  try { await run(dir); }
  finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

for (const promptInstalled of [false, true]) {
  test(`native child hooks preserve supervisor and permissions when prompt optimizer is ${promptInstalled ? 'disabled' : 'absent'}`, () => withDir(async dir => {
    if (promptInstalled) {
      await mkdir(join(dir, 'change-pi-prompt'), { recursive: true });
      await writeFile(join(dir, 'change-pi-prompt/config.json'), '{"enabled":false,"subagent":false}');
    }
    const parent = host(['read', 'subagent']);
    registerSubagentEnvironment(parent.pi, dir, { probeHost: { platform: process.platform, env: {}, exists: () => false } });
    await parent.emit('before_agent_start', { systemPrompt: 'Custom parent prompt' });
    assert.equal(existsSync(shellPolicySnapshotPath(dir, 'parent-a')), true);
    const child = host(['read', 'write', 'contact_supervisor']);
    const hooks = createChildHooks({ parentSessionId: 'parent-a', depth: 1, fanoutChild: false, inheritSkills: false, fast: false, waitTool: { enabled: false } });
    for (const hook of hooks) await hook.factory(child.pi);
    // No role marker or loaded extension is needed for a custom native child to remain a child.
    process.env[SHELL_POLICY_OWNER_ENV] = 'another-session';
    await child.emit('session_start', {});
    const prepared = await child.emit('before_agent_start', { systemPrompt: 'Custom role without an active_agent tag\n\nThe following skills provide specialized instructions for specific tasks.\n<available_skills>Private inherited skill</available_skills>' });
    assert.deepEqual(child.pi.getActiveTools(), ['read', 'contact_supervisor']);
    assert.match(prepared.systemPrompt, /pideck-subagent:child-tools/);
    assert.match(prepared.systemPrompt, /Complete only your assigned role-specific task/);
    assert.match(prepared.systemPrompt, /Custom role without an active_agent tag/);
    assert.doesNotMatch(prepared.systemPrompt, /Private inherited skill/);
    assert.equal(await child.emit('tool_call', { toolName: 'read', input: {} }), undefined);
    assert.equal(await child.emit('tool_call', { toolName: 'contact_supervisor', input: {} }), undefined);
    assert.equal((await child.emit('tool_call', { toolName: 'write', input: {} })).block, true);
    assert.equal(existsSync(join(dir, 'settings.json')), false, 'A child must not reconcile the parent settings');
    assert.equal(process.env[SHELL_POLICY_OWNER_ENV], 'another-session', 'A child must not publish a replacement parent owner');
  }));
}

test('legacy managed prompt providers migrate without deleting user-owned providers or settings', () => withDir(async dir => {
  const legacy = join(dir, 'change-pi-prompt');
  await mkdir(legacy, { recursive: true });
  const optimizer = join(process.cwd(), 'resources/extensions/pideck-q-change-pi-prompt.ts');
  const custom = join(dir, 'custom-provider.ts');
  await writeFile(custom, 'export default () => {}');
  await writeFile(join(legacy, 'managed-child-extensions.json'), JSON.stringify({ version: 1, managedPaths: [optimizer], managedTools: {} }));
  const initial = { keep: 'user-setting', subagents: { agentOverrides: { writable: { subagentOnlyExtensions: [optimizer, custom], custom: 42 } } } };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(initial));
  const result = await reconcileChildEnvironments({
    agentDir: dir, catalog: { packageRoot: undefined, agents: new Map([['writable', { name: 'writable', aliases: [], runnerType: 'native', tools: ['read'], filePath: 'fixture.md' }]]) },
    parentTools: [{ name: 'read', sourceInfo: { source: 'builtin' } }], parentActiveTools: ['read'],
    platform: process.platform, shellPolicy: { bash: false, powershell: false }, shellPolicyOwnerKey: 'parent-a',
  });
  assert.equal(result.canSafelyDispatch, true);
  const updated = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(updated, { ...initial, subagents: { agentOverrides: { writable: { subagentOnlyExtensions: [custom], custom: 42 } } } });
  assert.equal(existsSync(join(dir, 'subagents/environment/managed-child-extensions.json')), true);
  assert.equal(existsSync(join(legacy, 'managed-child-extensions.json')), true, 'Legacy user files are retained during migration');
  assert.equal(existsSync(shellPolicySnapshotPath(dir, 'parent-a')), true);
}));

test('legacy parent snapshots are readable but a current revoked policy stays authoritative', () => withDir(async dir => {
  await mkdir(join(dir, 'change-pi-prompt'), { recursive: true });
  const payload = { version: 2, platform: process.platform, shell: { bash: false, powershell: false }, parentActiveTools: ['read', 'write'] };
  await writeFile(join(dir, 'change-pi-prompt/effective-shell-policy.parent-a.json'), JSON.stringify(payload));
  assert.deepEqual(readEffectiveShellPolicySnapshot(dir, process.platform, 'parent-a').parentActiveTools, ['read', 'write']);
  await mkdir(join(dir, 'subagents/environment'), { recursive: true });
  await writeFile(shellPolicySnapshotPath(dir, 'parent-a'), JSON.stringify({ ...payload, parentActiveTools: ['read'] }));
  assert.deepEqual(readEffectiveShellPolicySnapshot(dir, process.platform, 'parent-a').parentActiveTools, ['read']);
}));


test('captured fanout hooks keep bounded foreground delegation and propagate ancestor revocation', () => withDir(async dir => {
  const parent = host(['read', 'write', 'subagent']);
  registerSubagentEnvironment(parent.pi, dir, { probeHost: { platform: process.platform, env: {}, exists: () => false } });
  await parent.emit('before_agent_start', { systemPrompt: 'Parent' });
  const child = host(['read', 'write', 'subagent', 'contact_supervisor'], 'child-a');
  for (const hook of createChildHooks({ parentSessionId: 'parent-a', depth: 1, maxDepth: 2, fanoutChild: true, fast: false, waitTool: { enabled: false } })) await hook.factory(child.pi);
  await child.emit('session_start', {});
  await child.emit('before_agent_start', { systemPrompt: 'Custom authorized fanout role' });
  assert.equal(await child.emit('tool_call', { toolName: 'subagent', input: { agent: 'readonly', task: 'Inspect one file', async: false } }), undefined);
  assert.ok(readEffectiveShellPolicySnapshot(dir, process.platform, 'child-a').parentActiveTools.includes('write'));
  assert.equal(process.env[SHELL_POLICY_OWNER_ENV], 'parent-a', 'A nested owner must not replace the process parent context');
  const grandchild = host(['read', 'write', 'contact_supervisor'], 'grandchild-a');
  for (const hook of createChildHooks({ parentSessionId: 'child-a', depth: 2, maxDepth: 2, fanoutChild: false, fast: false, waitTool: { enabled: false } })) await hook.factory(grandchild.pi);
  await grandchild.emit('session_start', {});
  await grandchild.emit('before_agent_start', { systemPrompt: 'Grandchild role' });
  assert.equal(await grandchild.emit('tool_call', { toolName: 'write', input: {} }), undefined);
  parent.pi.setActiveTools(['read', 'subagent']);
  await parent.emit('tool_call', { toolName: 'subagent', input: { agent: 'readonly', task: 'Next task' } });
  assert.equal((await grandchild.emit('tool_call', { toolName: 'write', input: {} })).block, true);
  assert.equal(await grandchild.emit('tool_call', { toolName: 'contact_supervisor', input: {} }), undefined);
  assert.equal((await grandchild.emit('tool_call', { toolName: 'subagent', input: { task: 'Unauthorized nesting' } })).block, true);
}));
