/** A native child's extension load must not change a concurrently reloaded parent identity. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { HARNESS_ROOT } from './helpers/subagentResumeHarness.mjs';
import { piFixtureFileUrl } from '../scripts/pi-compatibility-fixture.mjs';

await import('./helpers/piFixtureResolver.mjs');
const sdk = await import(piFixtureFileUrl('dist/index.js'));
const { AuthStorage } = await import(piFixtureFileUrl('dist/core/auth-storage.js'));
const { createEventBus } = await import(piFixtureFileUrl('dist/core/event-bus.js'));
const { default: registerSubagentExtension } = await import('../resources/extensions/pideck-q-subagents/src/extension/index.ts');
const { createDefaultChildSessionFactory, setChildSessionFactory } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-session.ts');
const { buildInProcessChildLaunch } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts');
const { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-runtime-config.ts');
const { SHELL_POLICY_OWNER_ENV } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/policySnapshot.ts');

test('a real parent SDK reload retains parent tools while a native child extension is still loading', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(HARNESS_ROOT, 'parent-reload-environment-'));
  const prior = Object.fromEntries(['PI_CODING_AGENT_DIR', SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV, SHELL_POLICY_OWNER_ENV].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env[SUBAGENT_CHILD_ENV];
  await writeFile(join(dir, 'settings.json'), '{}');
  await mkdir(join(dir, 'subagents'), { recursive: true });
  await writeFile(join(dir, 'subagents/config.json'), JSON.stringify({ fleetView: false, asyncWidget: false, waitTool: { enabled: false } }));
  const events = createEventBus();
  const errors = [];
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir: dir, eventBus: events, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: 'actual-parent-subagents', factory: registerSubagentExtension }],
  });
  sdk.initTheme('dark');
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const createModelRuntime = () => sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const modelRuntime = await createModelRuntime();
  const { session } = await sdk.createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, resourceLoader: loader,
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    sessionManager: sdk.SessionManager.inMemory(dir), tools: ['read', 'subagent'],
  });
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
    ...sdk, ModelRuntime: { create: createModelRuntime },
  }) });
  // Use the same factory the real parent shutdown handler disposes during reload.
  setChildSessionFactory(factory);
  let enterLoading;
  let releaseLoading;
  const loading = new Promise(resolve => { enterLoading = resolve; });
  const blocked = new Promise(resolve => { releaseLoading = resolve; });
  const launch = buildInProcessChildLaunch({
    host: 'parent', cwd: dir, parentSessionId: session.sessionId, childAgentName: 'readonly', childIndex: 0,
    sessionEnabled: false, tools: ['read'], systemPrompt: 'Inspect the assigned file.',
    inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, waitToolEnabled: false,
  }).session;
  // Async extension factories are a real SDK contract. Hold only this child's loader open.
  launch.hooks.push({ name: 'paused-child-provider', factory: async () => { enterLoading(); await blocked; } });
  const pendingChild = factory.create({ ...launch, onExtensionError: error => errors.push(error) });
  let child;
  try {
    await loading;
    assert.ok(session.getToolDefinition('subagent'), 'The parent must expose its subagent tool before reload');
    assert.equal(session.isStreaming, false, 'Direct and retained child work can coexist with an idle parent');
    await session.reload();
    const parentHasToolAfterReload = !!session.getToolDefinition('subagent');
    releaseLoading();
    child = await pendingChild;
    assert.deepEqual({ afterReload: parentHasToolAfterReload, afterChildBind: !!session.getToolDefinition('subagent') },
      { afterReload: true, afterChildBind: true }, 'A child loader must not cause a parent wrapper to install as a child during reload');
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(errors, []);
  } finally {
    releaseLoading();
    child ??= await pendingChild;
    await child.dispose();
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    await factory.dispose();
    setChildSessionFactory(undefined);
    events.clear();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
