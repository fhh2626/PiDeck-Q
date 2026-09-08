import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_PROMPTS } from '../defaults.ts';
import { transformSystemPrompt } from '../transform.ts';

// Optional fixture provider: a separately installed, pinned Pi package. No real model/process/network.
const packageDir = process.env.CHANGE_PI_PROMPT_TEST_PI_DIR;
test('real Pi 0.84.4 builder: default, append, CRLF context and no-context layouts', { skip: !packageDir }, async () => {
  const { buildSystemPrompt } = await import(pathToFileURL(join(packageDir, 'dist/core/system-prompt.js')).href);
  for (const contextFiles of [[], [{ path: '/project/AGENTS.md', content: 'Guidelines:\r\nDO NOT TOUCH\r\nPi documentation (example)' }]]) {
    for (const appendSystemPrompt of [undefined, 'User-owned appended instructions']) {
      const options = { cwd: '/project', selectedTools: ['read'], toolSnippets: { read: 'Read file contents' }, promptGuidelines: ['Use read to examine files instead of cat or sed.'], contextFiles, appendSystemPrompt };
      const input = buildSystemPrompt(options);
      const result = transformSystemPrompt({ systemPrompt: input, options, tools: [{ name: 'read', promptGuidelines: options.promptGuidelines, sourceInfo: { source: 'builtin' } }], activeTools: ['read'], config: DEFAULT_CONFIG, prompts: DEFAULT_PROMPTS, hostOs: 'Windows', today: '2026-09-08' });
      assert.notEqual(result.systemPrompt, input, result.diagnostics.join('; '));
      assert.match(result.systemPrompt, /You are Pi,/);
      assert.doesNotMatch(result.systemPrompt, /- Main documentation:/);
      assert.ok(result.systemPrompt.endsWith('Current working directory: /project'));
      for (const file of contextFiles) assert.ok(result.systemPrompt.includes(file.content));
      if (appendSystemPrompt) assert.ok(result.systemPrompt.includes(appendSystemPrompt));
    }
  }
});
