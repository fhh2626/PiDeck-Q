/** Explicitly loaded wrappers must stay child-scoped inside the shared parent process. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { HARNESS_ROOT } from './helpers/subagentResumeHarness.mjs';
import { piFixtureFileUrl } from '../scripts/pi-compatibility-fixture.mjs';

await import('./helpers/piFixtureResolver.mjs');
const sdkEntry = piFixtureFileUrl('dist/index.js');
const sdk = await import(sdkEntry);
const { AuthStorage } = await import(piFixtureFileUrl('dist/core/auth-storage.js'));
const yamlUrl = pathToFileURL(createRequire(sdkEntry).resolve('yaml')).href;
const yamlResolver = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'yaml' ? { url: yamlUrl, shortCircuit: true } : next(specifier, context);
} });
after(() => yamlResolver.deregister());
const { createDefaultChildSessionFactory } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-session.ts');
const { buildInProcessChildLaunch } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts');
const { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } = await import('../resources/extensions/pideck-q-subagents/src/runs/shared/child-runtime-config.ts');
const { SHELL_POLICY_OWNER_ENV } = await import('../resources/extensions/pideck-q-subagents/src/policy/environment/policySnapshot.ts');

for (const fanout of [false, true]) {
  test(`a real SDK ${fanout ? 'fanout' : 'ordinary'} child wrapper preserves the parent permission route through shutdown`, { timeout: 15_000 }, async () => {
    const dir = await mkdtemp(join(HARNESS_ROOT, 'wrapper-environment-'));
    const prior = Object.fromEntries(['PI_CODING_AGENT_DIR', SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV, SHELL_POLICY_OWNER_ENV].map(key => [key, process.env[key]]));
    process.env.PI_CODING_AGENT_DIR = dir;
    delete process.env[SUBAGENT_CHILD_ENV];
    process.env[SUBAGENT_PARENT_SESSION_ENV] = 'permission-parent';
    process.env[SHELL_POLICY_OWNER_ENV] = 'permission-parent';
    const errors = [];
    const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
      ...sdk,
      ModelRuntime: { create: () => sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false }) },
    }) });
    try {
      const launch = buildInProcessChildLaunch({
        host: 'parent', cwd: dir, parentSessionId: 'permission-parent', childAgentName: 'route-check', childIndex: 0,
        sessionEnabled: false, tools: fanout ? ['read', 'subagent'] : ['read'], allowNestedSubagents: fanout, maxSubagentDepth: 2,
        subagentOnlyExtensions: [resolve('resources/extensions/pideck-q-subagents.ts')], systemPrompt: 'Inspect the assigned file.',
        inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, waitToolEnabled: false,
      }).session;
      assert.equal(process.env[SUBAGENT_CHILD_ENV], undefined, 'Building a launch must not mutate the parent environment');
      const child = await factory.create({ ...launch, onExtensionError: error => errors.push(error) });
      const afterCreate = {
        parent: process.env[SUBAGENT_PARENT_SESSION_ENV],
        child: process.env[SUBAGENT_CHILD_ENV],
        owner: process.env[SHELL_POLICY_OWNER_ENV],
      };
      await child.dispose();
      const afterDispose = {
        parent: process.env[SUBAGENT_PARENT_SESSION_ENV],
        child: process.env[SUBAGENT_CHILD_ENV],
        owner: process.env[SHELL_POLICY_OWNER_ENV],
      };
      const expected = { parent: 'permission-parent', child: undefined, owner: 'permission-parent' };
      assert.deepEqual({ afterCreate, afterDispose }, { afterCreate: expected, afterDispose: expected },
        'Child creation and shutdown must preserve the parent ask-forwarding identity and restored child marker');
      assert.deepEqual(errors, []);
    } finally {
      await factory.dispose();
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
