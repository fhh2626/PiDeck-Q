import './helpers/piFixtureResolver.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { piFixtureFileUrl } from '../scripts/pi-compatibility-fixture.mjs';

const root = await mkdtemp(join(tmpdir(), 'subagent-prompt-sdk-'));
const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SUBAGENTS_TEMP_ROOT: process.env.PI_SUBAGENTS_TEMP_ROOT };
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_SUBAGENTS_TEMP_ROOT = join(root, 'runs');
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const { createExtensionRuntime, loadExtensionFromFactory } = await import(piFixtureFileUrl('dist/core/extensions/loader.js'));
const { ExtensionRunner } = await import(piFixtureFileUrl('dist/core/extensions/runner.js'));
const { SessionManager } = await import(piFixtureFileUrl('dist/core/session-manager.js'));
const { createEventBus } = await import(piFixtureFileUrl('dist/core/event-bus.js'));
const { buildSystemPrompt, buildSystemPromptSections } = await import(piFixtureFileUrl('dist/core/system-prompt.js'));
const { default: registerSubagents } = await import('../resources/extensions/pideck-q-subagents/src/extension/index.ts');
const { SUBAGENT_CALL_ANNOUNCEMENT_HINT } = await import('../resources/extensions/pideck-q-subagents/src/extension/delegation-hint.ts');
const { registerSubagentEnvironment } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/runtime.ts');
const { shellPolicySnapshotPath } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/policySnapshot.ts');
const { publishPromptAddition } = await import('../resources/extensions/pideck-q-subagents/src/shared/prompt-sections.ts');
const { registerPromptExtension } = await import('../resources/extensions/pideck-q-change-pi-prompt/runtime.ts');

/** Use Pi's actual loader and event runner so returned prompts acquire real ownership metadata. */
async function withRunner(factories, run) {
  const runtime = createExtensionRuntime();
  const eventBus = createEventBus();
  const extensions = [];
  let active = ['read', 'subagent'];
  runtime.getActiveTools = () => [...active];
  runtime.setActiveTools = names => { active = [...names]; };
  runtime.getAllTools = () => [
    { name: 'read', sourceInfo: { source: 'builtin' } },
    ...extensions.flatMap(extension => [...extension.tools.values()].map(tool => ({
      ...tool.definition, sourceInfo: extension.sourceInfo,
    }))),
  ];
  runtime.getThinkingLevel = () => 'off';
  runtime.getSettings = () => ({});
  for (const [factory, name] of factories) extensions.push(await loadExtensionFromFactory(factory, root, eventBus, runtime, name));
  const runner = new ExtensionRunner(extensions, runtime, root, SessionManager.inMemory(root), { getAvailable: () => [] });
  const errors = [];
  runner.onError(error => errors.push(error));
  try {
    await run(runner);
    assert.deepEqual(errors, []);
  } finally {
    await runner.emit({ type: 'session_shutdown', reason: 'quit' });
    runtime.invalidate();
    eventBus.clear();
  }
}

const optimizer = [pi => registerPromptExtension(pi, root), '<prompt-optimizer>'];
const subagents = [registerSubagents, resolve('resources/extensions/pideck-q-subagents.ts')];
const promptOptions = () => ({
  cwd: root, selectedTools: ['read', 'subagent'], toolSnippets: { read: 'Read file contents', subagent: 'Delegate work' },
  sections: { pideck_subagents: 'Keep the caller-owned section exactly.' },
});

test('prompt additions retain exact composition for legacy hosts and complete rewrites', () => {
  for (const systemPromptOptions of [undefined, {}, { sections: {}, forceSystemPrompt: '' }]) {
    const systemPrompt = 'Owned base\n\nOwned addition';
    assert.deepEqual(publishPromptAddition({ systemPrompt: 'Owned base', systemPromptOptions }, systemPrompt, 'pideck_subagents'), { systemPrompt });
  }
  const sections = { caller: 'Keep this section.' };
  assert.deepEqual(publishPromptAddition({ systemPrompt: 'Old rendered prompt', systemPromptOptions: { sections } }, 'Rewritten prompt', 'pideck_subagents'), { systemPrompt: 'Rewritten prompt' });
  assert.deepEqual(sections, { caller: 'Keep this section.' });
});

for (const optimizerFirst of [false, true]) {
  test(`real SDK parent prompt remains optimized with subagents ${optimizerFirst ? 'after' : 'before'} the optimizer`, () =>
    withRunner(optimizerFirst ? [optimizer, subagents] : [subagents, optimizer], async runner => {
      const result = await runner.emitBeforeAgentStart({ messageType: 'user', prompt: 'Inspect the project' }, promptOptions());
      const prompt = buildSystemPrompt(result.systemPromptOptions);
      assert.match(prompt, /<!-- change-pi-prompt:v1 -->/);
      assert.doesNotMatch(prompt, /Pi documentation/);
      assert.equal(prompt.split(SUBAGENT_CALL_ANNOUNCEMENT_HINT).length - 1, 1);
      assert.equal(result.systemPromptOptions.sections.pideck_subagents, 'Keep the caller-owned section exactly.');
    }));
}

test('real SDK subagent announcements preserve an earlier forced prompt', () => withRunner([subagents, optimizer], async runner => {
  const forceSystemPrompt = buildSystemPrompt(promptOptions());
  const result = await runner.emitBeforeAgentStart({ messageType: 'user', prompt: 'Inspect the project' }, { ...promptOptions(), forceSystemPrompt });
  const prompt = buildSystemPrompt(result.systemPromptOptions);
  assert.ok(prompt.startsWith(forceSystemPrompt));
  assert.doesNotMatch(prompt, /<!-- change-pi-prompt:v1 -->/);
  assert.equal(prompt.split(SUBAGENT_CALL_ANNOUNCEMENT_HINT).length - 1, 1);
}));

for (const optimizerFirst of [false, true]) {
  test(`real SDK child keeps environment facts and removes stock docs with environment ${optimizerFirst ? 'after' : 'before'} the optimizer`, async () => {
    const policyPath = shellPolicySnapshotPath(root, 'prompt-parent');
    await mkdir(dirname(policyPath), { recursive: true });
    await writeFile(policyPath, JSON.stringify({ version: 2, platform: process.platform, shell: { bash: false, powershell: false }, parentActiveTools: ['read'] }));
    const environment = [pi => registerSubagentEnvironment(pi, root, { child: true, ownerKey: 'prompt-parent' }), '<child-environment>'];
    await withRunner(optimizerFirst ? [optimizer, environment] : [environment, optimizer], async runner => {
      await runner.emit({ type: 'session_start' });
      const result = await runner.emitBeforeAgentStart({ messageType: 'user', prompt: 'Read the assigned file' }, {
        cwd: root, selectedTools: ['read'], toolSnippets: { read: 'Read file contents' }, appendSystemPrompt: '<active_agent name="readonly"/>\nKeep the child role.',
      });
      const prompt = buildSystemPrompt(result.systemPromptOptions);
      assert.doesNotMatch(prompt, /Pi documentation/);
      assert.match(prompt, /Child Tool Environment/);
      assert.match(prompt, /Keep the child role\./);
    });
  });
}

test('a real native child without a role marker keeps its stock base when the optimizer loads as an explicit provider', async () => {
  const sdk = await import(piFixtureFileUrl('dist/index.js'));
  const { AuthStorage } = await import(piFixtureFileUrl('dist/core/auth-storage.js'));
  const { createDefaultChildSessionFactory } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-session.ts');
  const { buildInProcessChildLaunch } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts');
  const policyPath = shellPolicySnapshotPath(root, 'loader-prompt-parent');
  await mkdir(dirname(policyPath), { recursive: true });
  await writeFile(policyPath, JSON.stringify({ version: 2, platform: process.platform, shell: { bash: false, powershell: false }, parentActiveTools: ['read'] }));
  let session;
  const errors = [];
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
    ...sdk,
    ModelRuntime: { create: () => sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(root, 'loader-models-cache.json'), refreshOnCreate: false }) },
    createAgentSession: async options => {
      const created = await sdk.createAgentSession(options);
      session = created.session;
      return created;
    },
  }) });
  let child;
  try {
    const launch = buildInProcessChildLaunch({
      host: 'parent', cwd: root, parentSessionId: 'loader-prompt-parent', childAgentName: 'readonly', childIndex: 0,
      sessionEnabled: false, tools: ['read'], subagentOnlyExtensions: [resolve('resources/extensions/pideck-q-change-pi-prompt.ts')],
      inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, waitToolEnabled: false,
    }).session;
    child = await factory.create({ ...launch, onExtensionError: error => errors.push(error) });
    const options = { cwd: root, selectedTools: ['read'], toolSnippets: { read: 'Read file contents' } };
    const stock = buildSystemPromptSections(options);
    const result = await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'Read the assigned file' }, options);
    const prompt = buildSystemPrompt(result.systemPromptOptions);
    assert.doesNotMatch(prompt, /<active_agent\b/, 'This child must be identified through its loader without a role tag');
    assert.doesNotMatch(prompt, /<!-- change-pi-prompt:v1 -->/, 'A child must receive only documentation removal');
    assert.doesNotMatch(prompt, /Pi documentation/);
    assert.ok(prompt.includes(stock.preamble), 'The native child must retain Pi\'s stock identity');
    assert.ok(prompt.includes(stock.tools), 'The native child must retain its complete stock tools section');
    assert.ok(prompt.includes(stock.rules), 'The native child must retain its complete stock rules section');
    assert.match(prompt, /Child Tool Environment/);
    assert.deepEqual(errors, []);
  } finally {
    await child?.dispose();
    await factory.dispose();
  }
});
