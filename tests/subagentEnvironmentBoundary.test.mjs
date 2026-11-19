/** Actual extension bridges must prepare permissions without a parent model turn. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { HARNESS_ROOT, completedResult, resetDoubles, setRunSyncBehavior, runSyncCalls } from './helpers/subagentResumeHarness.mjs';
import { piFixtureFileUrl } from '../scripts/pi-compatibility-fixture.mjs';

await import('./helpers/piFixtureResolver.mjs');
// Only child/model execution is substituted. The SDK, extension entry point,
// correlated bridges, executor, session identity and policy publication are real.
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
const { default: registerSubagentExtension } = await import('../resources/extensions/pideck-q-subagents/src/extension/index.ts');
const { readEffectiveShellPolicySnapshot, writeEffectiveShellPolicySnapshot, SHELL_POLICY_OWNER_ENV } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/policySnapshot.ts');
const { SLASH_SUBAGENT_REQUEST_EVENT, SLASH_SUBAGENT_RESPONSE_EVENT } = await import('../resources/extensions/pideck-q-subagents/src/shared/types.ts');
const { SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT } = await import('../resources/extensions/pideck-q-subagents/src/api/delegation.ts');
const { SUBAGENT_RPC_REQUEST_EVENT, subagentRpcReplyEvent } = await import('../resources/extensions/pideck-q-subagents/src/extension/rpc.ts');
const { registerSubagentEnvironment } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/runtime.ts');

async function withParent(run, { settings = {}, captured = false, catalogAgent } = {}) {
  const dir = await mkdtemp(join(HARNESS_ROOT, 'environment-boundary-'));
  const prior = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, [SHELL_POLICY_OWNER_ENV]: process.env[SHELL_POLICY_OWNER_ENV] };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env[SHELL_POLICY_OWNER_ENV];
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings));
  await mkdir(join(dir, 'subagents'), { recursive: true });
  await writeFile(join(dir, 'subagents/config.json'), JSON.stringify({ fleetView: false, asyncWidget: false, waitTool: { enabled: false } }));
  const events = createEventBus();
  const errors = [];
  let context;
  const actualFactory = pi => {
    registerSubagentExtension(pi);
    pi.on('session_start', (_event, ctx) => { context = ctx; });
  };
  const extensionFactories = [];
  const additionalExtensionPaths = [];
  if (catalogAgent) {
    // Give the real SDK an on-disk package identity so policy discovery reads this
    // package's declared requirements, while the entry point stays production code.
    const extensionDir = join(dir, 'extensions');
    const agentsDir = join(extensionDir, 'pideck-q-subagents', 'agents');
    await mkdir(agentsDir, { recursive: true });
    const definition = `---\nname: ${catalogAgent}\ndescription: Requires a provider\ntools: read, unavailable_fixture_tool\n---\nInspect one file.\n`;
    await writeFile(join(agentsDir, `${catalogAgent}.md`), definition);
    await mkdir(join(dir, '.pi', 'agents'), { recursive: true });
    await writeFile(join(dir, '.pi', 'agents', `${catalogAgent}.md`), definition);
    const wrapper = join(extensionDir, 'pideck-q-subagents.ts');
    await writeFile(wrapper, 'export default function(pi) { globalThis.__boundarySubagentExtension(pi); }');
    globalThis.__boundarySubagentExtension = actualFactory;
    additionalExtensionPaths.push(wrapper);
  } else {
    extensionFactories.push({ name: 'actual-subagent-extension', factory: actualFactory });
  }
  if (captured) {
    // The native hook's policy registration on a distinct SDK ExtensionAPI is
    // enough to test routing without registering duplicate coordination tools.
    extensionFactories.push({ name: 'captured-child-policy', factory(pi) {
      registerSubagentEnvironment(pi, dir, { child: true, allowNested: false, ownerKey: 'owning-parent' });
    } });
  }
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir: dir, eventBus: events, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories, additionalExtensionPaths,
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
    assert.deepEqual(errors, []);
    resetDoubles();
    const childSessionFile = join(dir, 'child-session.jsonl');
    await writeFile(childSessionFile, '');
    await run({ dir, events, session, context, childSessionFile, errors });
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    events.clear();
    delete globalThis.__boundarySubagentExtension;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function correlated(events, requestEvent, responseEvent, payload) {
  const requestId = `boundary-${Math.random()}`;
  return new Promise((resolve) => {
    const release = events.on(typeof responseEvent === 'function' ? responseEvent(requestId) : responseEvent, response => {
      if (response.requestId !== requestId) return;
      release();
      resolve(response);
    });
    events.emit(requestEvent, { requestId, ...payload });
  });
}

function slash(events, params) {
  const requestId = `boundary-${Math.random()}`;
  return new Promise((resolve) => {
    const release = events.on(SLASH_SUBAGENT_RESPONSE_EVENT, response => {
      if (response.requestId !== requestId) return;
      release();
      resolve(response);
    });
    events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params });
  });
}

const direct = { agent: 'readonly', task: 'Inspect the assigned file', context: 'fresh', acceptance: false, output: false };

test('the actual slash bridge publishes the parent permission snapshot before its first child launch', { timeout: 10_000 }, () => withParent(async fixture => {
  let policyAtLaunch;
  setRunSyncBehavior(({ agentName }) => {
    policyAtLaunch = readEffectiveShellPolicySnapshot(fixture.dir, process.platform, fixture.session.sessionId);
    return completedResult(fixture, { agent: agentName });
  });
  const response = await slash(fixture.events, direct);
  assert.equal(response.isError, false, JSON.stringify(response));
  assert.equal(runSyncCalls.length, 1, 'The real executor must reach the child execution boundary');
  assert.ok(policyAtLaunch, 'A direct bridge launch must publish its owner policy before child execution');
  assert.deepEqual(policyAtLaunch.parentActiveTools, fixture.session.getActiveToolNames());
}));

test('the actual correlated delegation API publishes permissions without a parent model turn', { timeout: 10_000 }, () => withParent(async fixture => {
  let policyAtLaunch;
  setRunSyncBehavior(({ agentName }) => {
    policyAtLaunch = readEffectiveShellPolicySnapshot(fixture.dir, process.platform, fixture.session.sessionId);
    return completedResult(fixture, { agent: agentName });
  });
  const response = await correlated(fixture.events, SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT, {
    ownerRunId: 'caller-owner', nodeId: 'first-child', agent: 'readonly', task: 'Inspect the assigned file',
    context: 'fresh', cwd: fixture.dir, result: { kind: 'text' },
  });
  assert.equal(response.status, 'completed', JSON.stringify(response));
  assert.equal(runSyncCalls.length, 1);
  assert.ok(policyAtLaunch, 'Correlated delegation must prepare the real parent owner before child execution');
  assert.deepEqual(policyAtLaunch.parentActiveTools, fixture.session.getActiveToolNames());
}));

test('RPC resume refreshes permissions after direct public execution and parent tool revocation', { timeout: 10_000 }, () => withParent(async fixture => {
  const owner = fixture.session.sessionId;
  assert.equal(writeEffectiveShellPolicySnapshot(join(fixture.dir, 'subagents', 'environment'), process.platform,
    { bash: false, powershell: false }, owner, fixture.session.getActiveToolNames()), true);
  const policies = [];
  setRunSyncBehavior(({ agentName }) => {
    policies.push(readEffectiveShellPolicySnapshot(fixture.dir, process.platform, owner));
    return completedResult(fixture, { agent: agentName });
  });
  // Calling the registered public definition is the same executor entry used by
  // extension callers. It intentionally bypasses Pi's tool_call event dispatch.
  const initial = await fixture.session.getToolDefinition('subagent').execute('direct-public', direct, new AbortController().signal, undefined, fixture.context);
  assert.notEqual(initial.isError, true, JSON.stringify(initial));
  assert.ok(initial.details.runId);
  fixture.session.setActiveToolsByName(['read', 'subagent']);
  const response = await correlated(fixture.events, SUBAGENT_RPC_REQUEST_EVENT, subagentRpcReplyEvent, {
    version: 1, method: 'resume', params: { id: initial.details.runId, message: 'Recheck the same file' },
  });
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(runSyncCalls.length, 2);
  assert.ok(policies[0].parentActiveTools.includes('write'));
  assert.deepEqual(policies[1].parentActiveTools, ['read', 'subagent'], 'RPC resume must publish the current ceiling before reopening a child');
}));

test('the actual slash bridge rejects a child whose required provider cannot be loaded', { timeout: 10_000 }, () => withParent(async fixture => {
  setRunSyncBehavior(({ agentName }) => completedResult(fixture, { agent: agentName }));
  const response = await slash(fixture.events, { ...direct, agent: 'provider-required' });
  assert.equal(response.isError, true, JSON.stringify(response));
  assert.match(response.errorText, /requires child-loadable providers.*unavailable_fixture_tool/);
  assert.equal(runSyncCalls.length, 0, 'Compatibility rejection must happen before child execution');
}, { catalogAgent: 'provider-required' }));

test('direct bridge delegation obeys a captured child owner instead of publishing a new parent policy', { timeout: 10_000 }, () => withParent(async fixture => {
  setRunSyncBehavior(({ agentName }) => completedResult(fixture, { agent: agentName }));
  const response = await slash(fixture.events, direct);
  assert.equal(response.isError, true, JSON.stringify(response));
  assert.match(response.errorText, /Child agents cannot launch nested delegation/);
  assert.equal(runSyncCalls.length, 0);
  assert.equal(readEffectiveShellPolicySnapshot(fixture.dir, process.platform, fixture.session.sessionId), undefined);
  assert.equal(process.env[SHELL_POLICY_OWNER_ENV], undefined, 'The optional wrapper must forward to its captured owner');
}, { captured: true }));
