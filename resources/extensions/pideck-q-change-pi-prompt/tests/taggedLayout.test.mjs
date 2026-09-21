import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, DEFAULT_PROMPTS } from '../defaults.ts';
import { OWN_END, transformSystemPrompt } from '../transform.ts';

// Stable Pi 0.86.1 layout fixture; independent of whichever Pi npm latest installs next.
const identity = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';
const docs = `<docs>
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /pi/README.md
- Additional docs: /pi/docs
- Examples: /pi/examples (extensions, custom tools, SDK)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
</docs>`;
const rules = ['Use read to examine files instead of cat or sed.', 'Be concise in your responses', 'Show file paths clearly when working with files'];
const tail = '\n\n<addendum>\nUser-owned appended instructions\n</addendum>\n\n<project_context>\n<rules>KEEP\r\n</rules>\nPi documentation (example)\n</project_context>\n\n<skills>\n<docs>KEEP SKILLS</docs>\n</skills>\n\n<cwd>\n/project\n</cwd>\n\n<extension_section>KEEP TAIL</extension_section>';
function fixture({ rows = '- read: Read file contents', guidance = rules, suffix = tail } = {}) {
  return `${identity}\n\n<tools>\n${rows}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>\n\n<rules>\n${guidance.map(rule => '- ' + rule).join('\n')}\n</rules>\n\n${docs}${suffix}`;
}
function run(systemPrompt, overrides = {}) {
  return transformSystemPrompt({ systemPrompt, options: {}, tools: [{ name: 'read', promptGuidelines: [rules[0]], sourceInfo: { source: 'builtin' } }], activeTools: ['read'], config: DEFAULT_CONFIG, prompts: DEFAULT_PROMPTS, hostOs: 'Windows', today: '2026-09-08', ...overrides });
}

test('tagged default header transforms while context, skills, cwd and appended tail remain exact', () => {
  const input = fixture();
  const result = run(input, { options: { appendSystemPrompt: 'User-owned appended instructions' } });
  assert.notEqual(result.systemPrompt, input, result.diagnostics.join('; '));
  assert.match(result.systemPrompt, /You are Pi,/);
  assert.doesNotMatch(result.systemPrompt, /- Main documentation:/);
  assert.equal(result.systemPrompt.slice(result.systemPrompt.indexOf(OWN_END) + OWN_END.length), tail);
  assert.ok(result.systemPrompt.includes('<tools>\n- read: Read file contents'));
  assert.equal(run(result.systemPrompt).systemPrompt, result.systemPrompt);
});

test('tagged header keeps unowned multiline CRLF guidance and unchanged documentation when enabled', () => {
  const extra = 'Extension-owned instruction\n  - nested continuation';
  const input = fixture({ guidance: [...rules, extra], suffix: '\n\n<cwd>\n/project\n</cwd>' }).replaceAll('\n', '\r\n');
  const result = run(input, { config: { ...DEFAULT_CONFIG, removeDocumentation: false } });
  assert.notEqual(result.systemPrompt, input);
  assert.ok(result.systemPrompt.includes('- ' + extra.replaceAll('\n', '\r\n')));
  assert.ok(result.systemPrompt.includes(docs.replaceAll('\n', '\r\n')));
  assert.ok(result.systemPrompt.endsWith('\r\n\r\n<cwd>\r\n/project\r\n</cwd>'));
  assert.equal(run(input, { config: { ...DEFAULT_CONFIG, unknownGuidelines: 'skip' } }).systemPrompt, input);
});

test('tagged rules remain intact when guideline replacement is disabled', () => {
  const input = fixture();
  const result = run(input, { config: { ...DEFAULT_CONFIG, replaceGuidelines: false } });
  assert.notEqual(result.systemPrompt, input);
  assert.ok(result.systemPrompt.includes(`<rules>\n${rules.map(rule => '- ' + rule).join('\n')}\n</rules>`));
});

test('tagged tool row pruning keeps wrappers and custom-tool notice even when no rows remain', () => {
  for (const rows of ['- bash: Run command', '(none)']) {
    const result = run(fixture({ rows }), { activeTools: [], tools: [] });
    assert.match(result.systemPrompt, /<tools>\n\(none\)\n\nIn addition to the tools above[^]*?\n<\/tools>/);
    assert.doesNotMatch(result.systemPrompt, /- bash:/);
  }
});

test('malformed, mixed and reordered tagged headers preserve the entire original', () => {
  const input = fixture();
  for (const malformed of [
    input.replace('</tools>', ''), input.replace('</rules>', ''), input.replace('</docs>', ''),
    input.replace('<rules>', 'Guidelines:'), input.replace('<docs>', '<unknown>'),
    input.replace('<tools>', '<rules>'), input.replace('- Main documentation:', '- Renamed documentation:'),
    input.replace('- read: Read file contents', 'Unrecognized tools body'),
    input.replace('- Use read to examine files instead of cat or sed.', 'Unindented custom prose'),
  ]) {
    const result = run(malformed);
    assert.equal(result.systemPrompt, malformed);
    assert.match(result.diagnostics[0], /unsupported-layout/);
  }
});

test('custom prompts and ambiguous append boundaries stay opaque for tagged layout', () => {
  const input = fixture();
  assert.equal(run(input, { options: { customPrompt: identity } }).systemPrompt, input);
  assert.equal(run(input, { options: { appendSystemPrompt: 'Read file contents' } }).systemPrompt, input);
});
