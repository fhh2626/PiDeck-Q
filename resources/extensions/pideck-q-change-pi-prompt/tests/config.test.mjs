import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROMPTS, DEFAULT_CONFIG } from '../defaults.ts';
import { loadSettings, initializeSettings } from '../config.ts';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'change-pi-prompt-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('missing configuration uses defaults without creating files', () => withDir(async dir => {
  const value = await loadSettings(dir);
  assert.equal(value.prompts.identity, DEFAULT_PROMPTS.identity);
  assert.equal(value.config.pruneUnavailableShells, DEFAULT_CONFIG.pruneUnavailableShells);
  await assert.rejects(readFile(join(dir, 'change-pi-prompt/config.json')), { code: 'ENOENT' });
}));
test('init is non-overwriting and Markdown overrides remain literal', () => withDir(async dir => {
  await initializeSettings(dir);
  const file = join(dir, 'change-pi-prompt/prompts/identity.md');
  await writeFile(file, 'Custom $& $1 identity');
  await initializeSettings(dir);
  assert.equal((await loadSettings(dir)).prompts.identity, 'Custom $& $1 identity');
}));
test('custom shell.md override is preserved across initializeSettings and loaded literally', () => withDir(async dir => {
  await initializeSettings(dir);
  const shellFile = join(dir, 'change-pi-prompt/prompts/shell.md');
  const customContent = 'Custom $& $1 shell guide with bash specific recommendations';
  await writeFile(shellFile, customContent, 'utf8');
  await initializeSettings(dir);
  const readBack = await readFile(shellFile, 'utf8');
  assert.equal(readBack, customContent);
  const loaded = await loadSettings(dir);
  assert.equal(loaded.prompts.shell, customContent);
}));
test('invalid config fails rather than silently enabling defaults', () => withDir(async dir => {
  await initializeSettings(dir);
  await writeFile(join(dir, 'change-pi-prompt/config.json'), '{"enabled":"false"}');
  await assert.rejects(loadSettings(dir), /enabled/);
}));
test('unknown keys and prototype keys are rejected', () => withDir(async dir => {
  await initializeSettings(dir);
  for (const json of ['{"unknown":true}', '{"__proto__":{}}']) {
    await writeFile(join(dir, 'change-pi-prompt/config.json'), json);
    await assert.rejects(loadSettings(dir), /Unknown config/);
  }
}));
test('empty templates and unsupported placeholders fail atomically', () => withDir(async dir => {
  await initializeSettings(dir);
  const file = join(dir, 'change-pi-prompt/prompts/identity.md');
  await writeFile(file, '');
  await assert.rejects(loadSettings(dir), /Empty template/);
  await writeFile(file, '{{unknown}}');
  await assert.rejects(loadSettings(dir), /placeholder/);
}));
test('oversized templates are bounded', () => withDir(async dir => {
  await initializeSettings(dir);
  await writeFile(join(dir, 'change-pi-prompt/prompts/identity.md'), 'x'.repeat(70 * 1024));
  await assert.rejects(loadSettings(dir), /too large/);
}));
test('directory in place of template is rejected', () => withDir(async dir => {
  await mkdir(join(dir, 'change-pi-prompt/prompts/identity.md'), { recursive: true });
  await assert.rejects(loadSettings(dir), /regular file/);
}));

test('legacy integration switches load without controlling other extensions', () => withDir(async dir => {
  await initializeSettings(dir);
  await writeFile(join(dir, 'change-pi-prompt/config.json'), '{"enabled":false,"subagent":false,"pwsh":false}');
  const value = await loadSettings(dir);
  assert.equal(value.config.enabled, false);
  assert.equal(Object.hasOwn(value.config, 'subagent'), false);
  assert.equal(Object.hasOwn(value.config, 'pwsh'), false);
  await assert.rejects(readFile(join(dir, 'change-pi-prompt/prompts/delegation.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dir, 'subagent-tool-description.md')), { code: 'ENOENT' });
}));
