import './helpers/piFixtureResolver.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { piFixtureFileUrl } from '../scripts/pi-compatibility-fixture.mjs';

const sdkEntry = piFixtureFileUrl('dist/index.js');
const sdk = await import(sdkEntry);
const { AuthStorage } = await import(piFixtureFileUrl('dist/core/auth-storage.js'));
const { createEventBus } = await import(piFixtureFileUrl('dist/core/event-bus.js'));
// Jiti resolves yaml through its own require, whose parent is outside resources/extensions.
// Keep that fixture-only dependency mapping local to this test process, without NODE_PATH.
const fixtureRequire = createRequire(sdkEntry);
const yamlUrl = pathToFileURL(fixtureRequire.resolve('yaml')).href;
const yamlResolver = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'yaml' ? { url: yamlUrl, shortCircuit: true } : next(specifier, context);
} });
after(() => yamlResolver.deregister());

const { createDefaultChildSessionFactory } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-session.ts');
const { buildInProcessChildLaunch } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts');
const { createChildHooks } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-hooks.ts');
const { registerSubagentEnvironment } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/runtime.ts');
const { readEffectiveShellPolicySnapshot, shellPolicySnapshotPath, SHELL_POLICY_OWNER_ENV } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/policySnapshot.ts');
const { selectParentTools } = await import('../resources/extensions/pideck-q-subagents/src/agents/parent-tool-inheritance.ts');
const wrapper = resolve('resources/extensions/pideck-q-subagents.ts');
const packageRoot = resolve('resources/extensions/pideck-q-subagents');

async function withAgentDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-policy-sdk-'));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, [SHELL_POLICY_OWNER_ENV]: process.env[SHELL_POLICY_OWNER_ENV] };
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env[SHELL_POLICY_OWNER_ENV] = 'parent-a';
  try { await run(dir); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function publishParent(dir, tools = ['read', 'write', 'subagent', 'bg_wait']) {
  const file = shellPolicySnapshotPath(dir, 'parent-a');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 2, platform: process.platform, shell: { bash: false, powershell: false }, parentActiveTools: tools }));
}

const nestedCall = { type: 'tool_call', toolName: 'subagent', toolCallId: 'nested-test', input: { agent: 'readonly', task: 'Inspect one file', async: false } };
const beforeStart = session => session.extensionRunner.emitBeforeAgentStart({ prompt: 'Check the assigned task' }, { cwd: session.sessionManager.getCwd(), customPrompt: session.systemPrompt, selectedTools: session.getActiveToolNames() });

test('tools: parent skips the bundled sibling wrapper and retains other loadable providers', () => withAgentDir(async dir => {
  const provider = join(dir, 'custom-tool.ts');
  await writeFile(provider, 'export default () => {};');
  const selection = selectParentTools({
    ownPackageRoot: packageRoot, activeToolNames: ['read', 'subagent', 'bg_wait', 'custom_tool'],
    allTools: [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'subagent', sourceInfo: { source: 'local', path: wrapper } },
      { name: 'bg_wait', sourceInfo: { source: 'local', path: wrapper } },
      { name: 'custom_tool', sourceInfo: { source: 'local', path: provider } },
    ],
  });
  assert.deepEqual(selection.extensionPaths, [provider]);
  assert.ok(selection.tools.includes('custom_tool'));
  assert.ok(selection.skipped.some(item => item.name === 'bg_wait' && item.reason === 'subagent-owned'));
}));

for (const rolePrompt of ['Delegate one task.', undefined]) {
  test(`default real SDK child honors captured fanout with an explicit wrapper and ${rolePrompt ? 'a role marker' : 'no role marker'}`, () => withAgentDir(async dir => {
    await publishParent(dir);
    const errors = [];
    const sessions = [];
    const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
      ...sdk,
      ModelRuntime: { create: () => sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false }) },
      async createAgentSession(options) {
        const result = await sdk.createAgentSession(options);
        sessions.push(result.session);
        return result;
      },
    }) });
    try {
      const launch = buildInProcessChildLaunch({
        host: 'parent', cwd: dir, parentSessionId: 'parent-a', childAgentName: 'custom-fanout', childIndex: 0,
        sessionEnabled: false, tools: ['read', 'write', 'subagent', 'bg_wait'], allowNestedSubagents: true, maxSubagentDepth: 2,
        subagentOnlyExtensions: [wrapper], systemPrompt: rolePrompt,
        inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, waitToolEnabled: false,
      }).session;
      await factory.create({ ...launch, onExtensionError: error => errors.push(error) });
      const [session] = sessions;
      assert.ok(session, 'The default child route must create the real SDK session');
      await beforeStart(session);
      assert.equal(process.env[SHELL_POLICY_OWNER_ENV], 'parent-a', 'Only the captured policy may prepare a custom child');
      assert.ok(session.getActiveToolNames().includes('subagent'));
      assert.equal(await session.extensionRunner.emitToolCall(nestedCall), undefined);
      assert.ok(readEffectiveShellPolicySnapshot(dir, process.platform, session.sessionId).parentActiveTools.includes('write'));
      await publishParent(dir, ['read', 'bg_wait']);
      assert.equal((await session.extensionRunner.emitToolCall(nestedCall)).block, true);
      assert.equal((await session.extensionRunner.emitToolCall({ type: 'tool_call', toolName: 'write', toolCallId: 'revoked', input: {} })).block, true);
      assert.deepEqual(errors, []);
    } finally { await factory.dispose(); }
  }));
}

test('real SDK policy claims stay with their SessionManager on a shared bus and release on shutdown', () => withAgentDir(async dir => {
  await publishParent(dir);
  const eventBus = createEventBus();
  const sessions = [];
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const create = async ({ fanout, captured = true, sessionManager = sdk.SessionManager.inMemory(dir) }) => {
    const apis = [];
    const hooks = captured ? createChildHooks({ parentSessionId: 'parent-a', depth: 1, maxDepth: 2, fanoutChild: fanout, fast: false, waitTool: { enabled: false } }) : [];
    const loader = new sdk.DefaultResourceLoader({
      cwd: dir, agentDir: dir, eventBus, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: captured ? 'Custom child with no role marker' : '<active_agent name="fallback"/>\nChild role',
      extensionFactories: [
        { name: 'optional-package-policy', factory(pi) { apis.push(pi); registerSubagentEnvironment(pi, dir); } },
        ...hooks.map(hook => ({ ...hook, factory(pi) { apis.push(pi); return hook.factory(pi); } })),
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, modelRuntime, sessionManager,
      settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      tools: fanout ? ['read', 'write', 'subagent'] : ['read', 'write'],
    });
    sessions.push(session);
    const errors = [];
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    await beforeStart(session);
    assert.deepEqual(errors, []);
    if (captured) assert.notEqual(apis[0], apis[1], 'Pi creates distinct APIs for loaded extensions');
    return session;
  };
  try {
    const authorized = await create({ fanout: true });
    const ordinary = await create({ fanout: false });
    assert.notEqual(authorized.sessionManager, ordinary.sessionManager);
    assert.equal(await authorized.extensionRunner.emitToolCall(nestedCall), undefined);
    assert.equal((await ordinary.extensionRunner.emitToolCall(nestedCall)).block, true);
    assert.equal(await authorized.extensionRunner.emitToolCall(nestedCall), undefined, 'The second child cannot replace the first owner');
    await authorized.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    // Reuse the actual manager while the old API is still alive. A leaked claim would suppress
    // the fallback guard and incorrectly allow nested work in this replacement session.
    const replacement = await create({ fanout: false, captured: false, sessionManager: authorized.sessionManager });
    assert.equal((await replacement.extensionRunner.emitToolCall(nestedCall)).block, true);
    assert.equal((await ordinary.extensionRunner.emitToolCall(nestedCall)).block, true);
  } finally {
    for (const session of sessions) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    eventBus.clear();
  }
}));

test('a real SDK captured child cannot delegate before its session binding', () => withAgentDir(async dir => {
  await publishParent(dir);
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: createChildHooks({ parentSessionId: 'parent-a', depth: 1, maxDepth: 2, fanoutChild: true, fast: false, waitTool: { enabled: false } }),
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, resourceLoader: loader, tools: ['read', 'subagent'], sessionManager: sdk.SessionManager.inMemory(dir) });
  try {
    const denied = await session.extensionRunner.emitToolCall(nestedCall);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /not bound/);
    await session.bindExtensions({ mode: 'print' });
    await beforeStart(session);
    assert.equal(await session.extensionRunner.emitToolCall(nestedCall), undefined);
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
}));
