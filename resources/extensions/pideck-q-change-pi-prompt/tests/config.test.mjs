import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUBAGENT_DESCRIPTION, DEFAULT_PROMPTS } from '../defaults.ts';
import { loadSettings, initializeSettings, initializeSubagentDescription, inspectNativeAsyncByDefault, inspectNativeSubagentAsyncDefault, isPiSubagentsSkillPath, LOCAL_ASYNC_DEFAULT_SENTENCE, rewriteJsonStrings, rewriteSystemPromptTools, rewriteToolResultContent, rewriteUpstreamAsyncDefault, UPSTREAM_ASYNC_COMPACT_SENTENCE, UPSTREAM_ASYNC_DEFAULT_SENTENCE } from '../config.ts';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'change-pi-prompt-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('missing configuration uses defaults without creating files', () => withDir(async dir => {
  const value = await loadSettings(dir);
  assert.equal(value.prompts.identity, DEFAULT_PROMPTS.identity);
  await assert.rejects(readFile(join(dir, 'change-pi-prompt/config.json')), { code: 'ENOENT' });
}));
test('init is non-overwriting and Markdown overrides remain literal', () => withDir(async dir => {
  await initializeSettings(dir);
  const file = join(dir, 'change-pi-prompt/prompts/identity.md');
  await writeFile(file, 'Custom $& $1 identity');
  await initializeSettings(dir);
  assert.equal((await loadSettings(dir)).prompts.identity, 'Custom $& $1 identity');
}));
test('init creates coordinated delegation guidelines and native Agent description', () => withDir(async dir => {
  await initializeSettings(dir);
  await initializeSubagentDescription(dir);
  const delegation = await readFile(join(dir, 'change-pi-prompt/prompts/delegation.md'), 'utf8');
  const description = await readFile(join(dir, 'subagent-tool-description.md'), 'utf8');
  assert.equal(delegation.trim(), DEFAULT_PROMPTS.delegation);
  assert.match(delegation, /simple lookups/);
  assert.match(delegation, /multi-step exploration\/research/);
  assert.match(delegation, /intermediate results best kept out of the main context/);
  assert.match(delegation, /Known paths do not rule out delegation/);
  assert.match(delegation, /exactly one top-level subagent call with async:false/);
  assert.equal(description.trim(), SUBAGENT_DESCRIPTION.trim());
  assert.match(description, /exactly one top-level subagent call with async:false/);
  assert.match(description, /runs\.all returns an ordered array/);
  assert.match(description, /Every stored runs\.run promise/);
  assert.match(description, /structuredOutput\.verdict === "blocked"/);
  assert.match(description, /extension-owned script and authority/);
  assert.match(description, /source checkout must be clean/);
  assert.doesNotMatch(description, /\{\{|run_in_background|subagent_type|action:\s*"models"|model:\s*"inherit"/);
}));
test('native asyncByDefault must be explicit false', () => {
  const path = 'extensions/subagent/config.json';
  assert.equal(inspectNativeAsyncByDefault(undefined, path).ok, false);
  assert.equal(inspectNativeAsyncByDefault('{"toolDescriptionMode":"custom"}', path).ok, false);
  assert.equal(inspectNativeAsyncByDefault('{"asyncByDefault":true}', path).ok, false);
  assert.equal(inspectNativeAsyncByDefault('{"asyncByDefault":false}', path).ok, true);
});
test('inspectNativeSubagentAsyncDefault reads the native config file', () => withDir(async dir => {
  const missing = await inspectNativeSubagentAsyncDefault(dir);
  assert.equal(missing.ok, false);
  await mkdir(join(dir, 'extensions/subagent'), { recursive: true });
  await writeFile(join(dir, 'extensions/subagent/config.json'), '{"asyncByDefault":false}');
  const present = await inspectNativeSubagentAsyncDefault(dir);
  assert.equal(present.ok, true);
  assert.equal(present.asyncByDefault, false);
}));
test('upstream async default sentence is rewritten to name asyncByDefault:true', () => {
  const rewritten = rewriteUpstreamAsyncDefault(`prefix ${UPSTREAM_ASYNC_DEFAULT_SENTENCE} suffix`);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.text.includes(UPSTREAM_ASYNC_DEFAULT_SENTENCE), false);
  assert.match(rewritten.text, /Plugin default is asyncByDefault:true/);
  assert.equal(rewritten.text, `prefix ${LOCAL_ASYNC_DEFAULT_SENTENCE} suffix`);
  const prompt = rewriteSystemPromptTools(`keep ${UPSTREAM_ASYNC_DEFAULT_SENTENCE}`, [{ name: 'subagent', description: UPSTREAM_ASYNC_DEFAULT_SENTENCE }]);
  assert.deepEqual(prompt.rewritten, ['subagent']);
  assert.equal(prompt.systemPrompt.includes(UPSTREAM_ASYNC_DEFAULT_SENTENCE), false);
  const compact = rewriteUpstreamAsyncDefault(UPSTREAM_ASYNC_COMPACT_SENTENCE);
  assert.equal(compact.text, LOCAL_ASYNC_DEFAULT_SENTENCE);
  const payload = rewriteJsonStrings({ tools: [{ function: { description: `x ${UPSTREAM_ASYNC_DEFAULT_SENTENCE} y` } }] });
  assert.equal(payload.changed, true);
  assert.equal(JSON.stringify(payload.value).includes(UPSTREAM_ASYNC_DEFAULT_SENTENCE), false);
  assert.match(JSON.stringify(payload.value), /asyncByDefault:true/);
});
test('safety remainder and skill async defaults are rewritten without touching user async: true', () => {
  const safety = rewriteUpstreamAsyncDefault(`${UPSTREAM_ASYNC_DEFAULT_SENTENCE} Use async:false only when the parent must block until completion. Async mode still shows progress. Final reviews and gate checks stay async; needing a result is not a blocking reason. After an async launch, continue independent work only until its next dependency barrier; consume the result before work that depends on it. Ordinary async subagents notify this session natively, so return control and do not call bg_wait merely to get a completion wake. Do not sleep or poll status just to wait; use bg_wait only for provider, detached, or other background work without a native notification when this turn must receive its result.`);
  assert.equal(safety.changed, true);
  assert.doesNotMatch(safety.text, /Final reviews and gate checks stay async|After an async launch|return control and do not call bg_wait merely/);
  assert.match(safety.text, /async:false on every subagent launch/);
  const skill = rewriteUpstreamAsyncDefault('Use async/background by default. Set `async:false` only when the parent must
block. Final reviews, validation gates, oracle checks, and publication checks
stay async.');
  assert.match(skill.text, /This environment requires `async:false`/);
  assert.doesNotMatch(skill.text, /Use async\/background by default|publication checks\nstay async/);
  const user = rewriteUpstreamAsyncDefault('Please set async: true for this job.');
  assert.equal(user.changed, false);
  const drifted = rewriteUpstreamAsyncDefault('Use async/background by default. Set `async:false` only if the parent really must\nblock. Final reviews, validation gates, oracle checks, and publication checks\nstay async.');
  assert.match(drifted.text, /This environment requires `async:false`/);
  assert.equal(isPiSubagentsSkillPath('C:\\npm\\node_modules\\pi-subagents\\skills\\pi-subagents\\references\\execution-controls.md'), true);
  assert.equal(isPiSubagentsSkillPath('/home/user/.pi/agent/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md'), true);
  assert.equal(isPiSubagentsSkillPath('/Users/me/.pi/agent/npm/node_modules/pi-subagents/skills'), true);
  assert.equal(isPiSubagentsSkillPath('file:///C:/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md'), true);
  assert.equal(isPiSubagentsSkillPath('\\\\?\\C:\\npm\\node_modules\\pi-subagents\\skills\\pi-subagents\\SKILL.md'), true);
  assert.equal(isPiSubagentsSkillPath('C:\\project\\README.md'), false);
  assert.equal(isPiSubagentsSkillPath('C:\\project\\pi-subagents-other\\skills\\x.md'), false);
  const result = rewriteToolResultContent({ type: 'text', text: UPSTREAM_ASYNC_DEFAULT_SENTENCE });
  assert.equal(result.changed, true);
  assert.match(JSON.stringify(result.content), /asyncByDefault:true/);
});
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
test('native subagent template initialization never edits settings or overwrites user files', () => withDir(async dir => {
  const configDir = join(dir, 'extensions/subagent');
  await mkdir(configDir, { recursive: true });
  const configFile = join(configDir, 'config.json');
  await writeFile(configFile, '{"toolDescriptionMode":"full"}');
  await initializeSubagentDescription(dir);
  assert.equal((await readFile(join(dir, 'subagent-tool-description.md'), 'utf8')).trim(), SUBAGENT_DESCRIPTION.trim());
  await writeFile(join(dir, 'subagent-tool-description.md'), 'MY TEMPLATE');
  await initializeSubagentDescription(dir);
  assert.equal(await readFile(join(dir, 'subagent-tool-description.md'), 'utf8'), 'MY TEMPLATE');
  assert.equal(await readFile(configFile, 'utf8'), '{"toolDescriptionMode":"full"}');
}));
test('directory in place of template is rejected', () => withDir(async dir => {
  await mkdir(join(dir, 'change-pi-prompt/prompts/identity.md'), { recursive: true });
  await assert.rejects(loadSettings(dir), /regular file/);
}));
