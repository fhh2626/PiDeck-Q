/** Native fanout tools must enforce captured policy when called directly by extensions. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { HARNESS_ROOT, completedResult, resetDoubles, setRunSyncBehavior, runSyncCalls } from './helpers/subagentResumeHarness.mjs';
import { piFixtureFileUrl } from '../scripts/pi-compatibility-fixture.mjs';

await import('./helpers/piFixtureResolver.mjs');
// Keep the native hooks, real SDK binding and executor. Substitute only the model execution boundary.
const executionDouble = new URL('./helpers/subagentExecutionDouble.mjs', import.meta.url).href;
const executionResolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('pideck-q-subagents') && specifier.endsWith('/execution.ts')) {
    return { url: executionDouble, shortCircuit: true };
  }
  return next(specifier, context);
} });
after(() => executionResolver.deregister());

const sdk = await import(piFixtureFileUrl('dist/index.js'));
const { AuthStorage } = await import(piFixtureFileUrl('dist/core/auth-storage.js'));
const { createEventBus } = await import(piFixtureFileUrl('dist/core/event-bus.js'));
const { createChildHooks } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-hooks.ts');
const { readEffectiveShellPolicySnapshot, writeEffectiveShellPolicySnapshot, SHELL_POLICY_OWNER_ENV } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/policySnapshot.ts');

/** Bind the production captured environment and native fanout tool on their distinct SDK APIs. */
async function withFanout(run, { prepareTurn = true } = {}) {
  const dir = await mkdtemp(join(HARNESS_ROOT, 'fanout-environment-boundary-'));
  const prior = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, [SHELL_POLICY_OWNER_ENV]: process.env[SHELL_POLICY_OWNER_ENV] };
  process.env.PI_CODING_AGENT_DIR = dir;
  await writeFile(join(dir, 'settings.json'), '{}');
  await mkdir(join(dir, 'subagents'), { recursive: true });
  await writeFile(join(dir, 'subagents/config.json'), JSON.stringify({ fleetView: false, asyncWidget: false, waitTool: { enabled: false } }));
  const rootOwner = 'fanout-root-parent';
  assert.equal(writeEffectiveShellPolicySnapshot(join(dir, 'subagents', 'environment'), process.platform,
    { bash: false, powershell: false }, rootOwner, ['read', 'write', 'subagent']), true);
  const events = createEventBus();
  const errors = [];
  let context;
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir: dir, eventBus: events, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      ...createChildHooks({ parentSessionId: rootOwner, depth: 1, maxDepth: 2, fanoutChild: true, fast: false, waitTool: { enabled: false } }),
      { name: 'fanout-context', factory(pi) { pi.on('session_start', (_event, ctx) => { context = ctx; }); } },
    ],
  });
  sdk.initTheme('dark');
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const { session } = await sdk.createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, resourceLoader: loader,
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    sessionManager: sdk.SessionManager.inMemory(dir), tools: ['read', 'write', 'subagent'],
  });
  try {
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    if (prepareTurn) await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'Inspect the assigned files' }, {
      cwd: dir, customPrompt: '<active_agent name="readonly"/>\nInspect the assigned files.', selectedTools: ['read', 'write', 'subagent'],
    });
    resetDoubles();
    const childSessionFile = join(dir, 'grandchild-session.jsonl');
    await writeFile(childSessionFile, '');
    await run({ dir, session, context, rootOwner, childSessionFile });
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    events.clear();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const direct = { agent: 'readonly', task: 'Inspect the assigned file', context: 'fresh', acceptance: false, output: false, mission: false };

test('direct native fanout execution publishes its captured permission ceiling before launching a grandchild', { timeout: 10_000 }, () => withFanout(async fixture => {
  let policyAtLaunch;
  setRunSyncBehavior(({ agentName }) => {
    policyAtLaunch = readEffectiveShellPolicySnapshot(fixture.dir, process.platform, fixture.session.sessionId);
    return completedResult(fixture, { agent: agentName });
  });
  const result = await fixture.session.getToolDefinition('subagent').execute('direct-fanout', direct, new AbortController().signal, undefined, fixture.context);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(runSyncCalls.length, 1, 'The native fanout executor must reach the child execution boundary');
  assert.ok(policyAtLaunch, 'A direct native fanout launch must publish its own linked policy before child execution');
  assert.equal(policyAtLaunch.parentOwnerKey, fixture.rootOwner);
  assert.deepEqual(policyAtLaunch.parentActiveTools, fixture.session.getActiveToolNames());
  assert.equal(process.env[SHELL_POLICY_OWNER_ENV], fixture.rootOwner, 'Fanout publication must retain the process root owner');
}));

test('direct native fanout execution fails closed before its captured launch permissions are prepared', { timeout: 10_000 }, () => withFanout(async fixture => {
  setRunSyncBehavior(({ agentName }) => completedResult(fixture, { agent: agentName }));
  await assert.rejects(
    fixture.session.getToolDefinition('subagent').execute('unprepared-fanout', direct, new AbortController().signal, undefined, fixture.context),
    /launch-time permissions/,
  );
  assert.equal(runSyncCalls.length, 0, 'An unprepared child must not bypass the captured policy through direct tool execution');
  assert.equal(readEffectiveShellPolicySnapshot(fixture.dir, process.platform, fixture.session.sessionId), undefined);
}, { prepareTurn: false }));
