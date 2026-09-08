import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerPromptExtension } from '../runtime.ts';

async function harness(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'change-pi-runtime-'));
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const ctx = { hasUI: true, ui: { notify: message => notices.push(message), editor: async () => undefined } };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (name, definition) => commands.set(name, definition), getAllTools: () => [], getActiveTools: () => [] };
  registerPromptExtension(pi, dir);
  const command = arg => commands.get('change-pi-prompt').handler(arg, ctx);
  try { await fn({ dir, handlers, notices, ctx, command, pi }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('init-subagent without package is a safe no-op', () => harness(async ({ dir, command, notices }) => {
  await command('init-subagent');
  await assert.rejects(readFile(join(dir, 'agent-tool-description.md')), { code: 'ENOENT' });
  assert.ok(notices.some(x => x.includes('未检测到')));
}));
test('optional metadata APIs may be absent without breaking the hook', () => harness(async ({ handlers, ctx, pi }) => {
  delete pi.getAllTools;
  delete pi.getActiveTools;
  assert.equal(await handlers.get('before_agent_start')({ systemPrompt: 'CUSTOM' }, ctx), undefined);
}));
test('failed reload retains last-good settings and reports error', () => harness(async ({ dir, command, notices }) => {
  await command('init');
  await command('reload');
  await writeFile(join(dir, 'change-pi-prompt/config.json'), '{"enabled":"false"}');
  await command('reload');
  await command('status');
  assert.ok(notices.some(x => x.includes('命令失败')));
  assert.ok(notices.at(-1).includes('有效配置：已加载'));
}));
