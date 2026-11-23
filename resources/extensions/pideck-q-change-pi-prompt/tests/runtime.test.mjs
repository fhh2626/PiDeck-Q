import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../defaults.ts';
import { registerPromptExtension } from '../runtime.ts';

async function writeConfig(dir, overrides = {}) {
  await mkdir(join(dir, 'change-pi-prompt', 'prompts'), { recursive: true });
  await writeFile(join(dir, 'change-pi-prompt/config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...overrides }));
}

async function harness(fn, host = { platform: 'win32', env: { Path: '' }, exists: () => false, isStandalone: () => true }, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'change-pi-runtime-'));
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const ctx = { cwd: dir, hasUI: true, ui: { notify: message => notices.push(message), editor: async () => undefined } };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    getAllTools: () => pi._tools ?? [],
    getActiveTools: () => pi._active ?? [],
    setActiveTools: names => { pi._active = [...names]; },
    registerTool: tool => {
      const tools = [...(pi._tools ?? [])];
      const index = tools.findIndex(candidate => candidate.name === tool.name);
      if (index >= 0) tools[index] = tool;
      else tools.push(tool);
      pi._tools = tools;
    },
    _tools: [],
    _active: [],
  };
  const extensionOptions = {
    probeHost: host,
    isStandalone: host.isStandalone,
    ...options,
  };
  registerPromptExtension(pi, dir);
  const command = arg => commands.get('change-pi-prompt').handler(arg, ctx);
  try { await fn({ dir, handlers, notices, ctx, command, pi }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('failed reload retains last-good settings and reports error', () => harness(async ({ dir, command, notices }) => {
  await command('init');
  await command('reload');
  await writeFile(join(dir, 'change-pi-prompt/config.json'), '{"enabled":"false"}');
  await command('reload');
  await command('status');
  assert.ok(notices.some(x => x.includes('命令失败')));
  assert.ok(notices.at(-1).includes('有效配置：已加载'));
}));

// 需求变更：只要还有其它 shell 工具可用（这里保留了 powershell），
// 隐藏 bash 必须静默——原有的「每次 reload 都警告」被用户当成报错。

test('prompt optimizer never registers tool enforcement or rewrites messages', () => harness(async ({ handlers, pi, ctx, command, dir }) => {
  assert.equal(handlers.has('tool_call'), false);
  assert.equal(handlers.has('context'), false);
  assert.equal(handlers.has('before_provider_request'), false);
  assert.equal(handlers.has('tool_result'), false);
  pi._active = ['read', 'bash', 'subagent', 'ask_question'];
  await handlers.get('session_start')({}, ctx);
  await handlers.get('before_agent_start')({ systemPrompt: 'Custom parent prompt', systemPromptOptions: { customPrompt: 'Custom parent prompt' } }, ctx);
  assert.deepEqual(pi._active, ['read', 'bash', 'subagent', 'ask_question']);
  await command('init');
  await assert.rejects(readFile(join(dir, 'subagent-tool-description.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dir, 'settings.json')), { code: 'ENOENT' });
}));

test('child documentation removal preserves an extension-owned docs section', () => harness(async ({ handlers, ctx }) => {
  const docs = 'Pi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md\n- Additional docs: /pi/docs\n- Examples: /pi/examples\n- Child extension policy: Keep /team/child-guide.md available.';
  const systemPrompt = `You are a coding assistant inside pi.\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise in your responses\n</rules>\n\n<docs>\n${docs}\n</docs>\n\n<active_agent name="readonly"/>\nKeep the child role.`;
  const result = await handlers.get('before_agent_start')({ systemPrompt, systemPromptOptions: { sections: { docs } } }, ctx);
  assert.equal(result?.systemPrompt ?? systemPrompt, systemPrompt);
}));

for (const field of ['customPrompt', 'forceSystemPrompt']) {
  test(`child documentation removal preserves opaque ${field} text`, () => harness(async ({ handlers, ctx }) => {
    const systemPrompt = 'You are a coding assistant inside pi.\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise in your responses\n</rules>\n\n<docs>\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md\n- Additional docs: /pi/docs\n- Examples: /pi/examples\n</docs>\n\n<active_agent name="readonly"/>\nKeep the child role.';
    const result = await handlers.get('before_agent_start')({ systemPrompt, systemPromptOptions: { [field]: systemPrompt } }, ctx);
    assert.equal(result?.systemPrompt ?? systemPrompt, systemPrompt);
  }));
}
