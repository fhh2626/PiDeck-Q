/** SDK reload creates new extension modules, but child startup still shares process.env. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const KEY = 'PIDECK_TEST_RELOADED_CHILD_WINDOW';

test('real SDK module reloads share the foreground child environment startup queue', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(HARNESS_ROOT, 'child-module-isolation-'));
  const previous = process.env[KEY];
  process.env[KEY] = 'parent';
  const copies = [];
  globalThis.__captureReloadedChildFactory = factory => { copies.push(factory); };
  let releaseFirst;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  let first;
  let second;
  let firstResult;
  let secondResult;
  try {
    const source = resolve('resources/extensions/pideck-q-subagents/src/runs/shared/child-session.ts');
    const extension = join(dir, 'factory-provider.ts');
    await writeFile(extension, `import { createDefaultChildSessionFactory } from ${JSON.stringify(source)};\nexport default function() { globalThis.__captureReloadedChildFactory(createDefaultChildSessionFactory); }\n`);
    const loader = new sdk.DefaultResourceLoader({
      cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, additionalExtensionPaths: [extension],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(copies.length, 2);
    assert.notEqual(copies[0], copies[1], 'The installed SDK must really create independent module copies');

    const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    const observed = [];
    let markFirstStarted;
    const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
    const suppliedSdk = pause => ({
      ...sdk,
      ModelRuntime: { create: async () => modelRuntime },
      DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
        async reload() {
          observed.push(['loading', process.env[KEY]]);
          if (pause) { markFirstStarted(); await held; }
          return super.reload();
        }
      },
    });
    first = copies[0]({ loadPiCodingAgent: async () => suppliedSdk(true) });
    second = copies[1]({ loadPiCodingAgent: async () => suppliedSdk(false) });
    const launch = value => ({
      cwd: dir, storage: { kind: 'memory' }, extensionPaths: [], ambientExtensions: false,
      hooks: [], noSkills: true, noContextFiles: true,
      runtime: { fanoutChild: false, fast: false, waitTool: { enabled: false } }, processEnv: { [KEY]: value },
    });
    firstResult = first.create(launch('first'));
    await firstStarted;
    secondResult = second.create(launch('second'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(observed, [['loading', 'first']], 'A second module copy must wait for the first child to bind and restore process.env');
    releaseFirst();
    await Promise.all([firstResult, secondResult]);
    assert.deepEqual(observed, [['loading', 'first'], ['loading', 'second']]);
    assert.equal(process.env[KEY], 'parent');
  } finally {
    releaseFirst();
    await Promise.allSettled([firstResult, secondResult]);
    await Promise.all([first?.dispose(), second?.dispose()]);
    delete globalThis.__captureReloadedChildFactory;
    if (previous === undefined) delete process.env[KEY]; else process.env[KEY] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
