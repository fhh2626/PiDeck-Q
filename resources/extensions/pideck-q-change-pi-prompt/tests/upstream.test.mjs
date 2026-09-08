import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, DEFAULT_PROMPTS } from '../defaults.ts';
import { transformSystemPrompt } from '../transform.ts';

/**
 * 用「真实安装的 Pi」验证转换在 0.84.4 的 system-prompt 上成立。
 *
 * 解析顺序：
 *  1. CHANGE_PI_PROMPT_TEST_PI_DIR（手动指向某个 Pi 安装，便于对比不同版本）；
 *  2. 从本测试文件向上找 node_modules/@earendil-works/pi-coding-agent，
 *     以「dist/core/system-prompt.js 存在」为判定锚点（该包的 exports 表只暴露
 *     入口，子路径 require/import 都会被拦，所以不能直接按子路径解析）。
 *
 * 这个包现在是项目的 devDependency（只用于类型与测试，不进运行时打包），因此
 * 默认就能解析到；解析不到才退化为 skip。
 */
const here = dirname(fileURLToPath(import.meta.url));

function resolvePiPackageDir() {
	if (process.env.CHANGE_PI_PROMPT_TEST_PI_DIR) return process.env.CHANGE_PI_PROMPT_TEST_PI_DIR;
	let dir = here;
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
		if (existsSync(join(candidate, 'dist/core/system-prompt.js'))) return candidate;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}

const packageDir = resolvePiPackageDir();
const builderEntry = packageDir ? join(packageDir, 'dist/core/system-prompt.js') : null;

/** 组装一个最小的 TransformInput；纯用例只需占位，真实用例按需覆盖。 */
function makeInput(overrides = {}) {
	return {
		systemPrompt: 'placeholder',
		options: {},
		tools: [],
		activeTools: [],
		config: { ...DEFAULT_CONFIG },
		prompts: { ...DEFAULT_PROMPTS },
		hostOs: 'Windows',
		today: '2026-09-08',
		...overrides,
	};
}

/** 真实 Pi 默认布局的完整工具快照（与 Pi 0.84.4 buildSystemPrompt 的内置规则对齐）。 */
function defaultTools() {
	const readRule = 'Use read to examine files instead of cat or sed.';
	return [
		{ name: 'read', promptGuidelines: [readRule], sourceInfo: { source: 'builtin' } },
	];
}

// ---- 纯用例：不依赖真实 Pi 包，发版验证永远执行 -----------------------------

test('customPrompt (child/subagent prompt) is never modified', () => {
	// 子代理 / 自定义提示词走 Pi 的 customPrompt 分支，其结构完全由用户决定；
	// 我们的转换必须整体让路，不能只改一半。
	const childPrompt = 'You are a focused subagent.\n- do the thing\nCurrent working directory: /w';
	const input = makeInput({ systemPrompt: childPrompt, options: { customPrompt: 'You are a focused subagent.' } });
	const result = transformSystemPrompt(input);
	assert.equal(result.systemPrompt, input.systemPrompt, result.diagnostics.join('; '));
	assert.match(result.diagnostics[0], /custom-or-child-prompt/);
});

test('an unknown layout is preserved byte-for-byte (no partial transform)', () => {
	// 上游把默认头改得面目全非：有 "You are ... pi" 但结构不再匹配。
	// 有界解析器应当整体放弃，而不是改一个 section 留下另一个。
	const drifted = [
		'You are a next-generation assistant running inside pi today.',
		'We restructured the header completely.',
		'Here is what we now do:',
		'- read: reads a file',
		'- write: writes a file',
	].join('\n') + '\n';
	const input = makeInput({ systemPrompt: drifted });
	const result = transformSystemPrompt(input);
	assert.equal(result.systemPrompt, input.systemPrompt, result.diagnostics.join('; '));
	assert.match(result.diagnostics[0], /unsupported-layout/);
});

test('an already-transformed prompt is idempotent', () => {
	const once = transformSystemPrompt(makeInput({ systemPrompt: 'You are an expert coding assistant operating inside pi, a coding agent harness.\n\nAvailable tools:\n- read: Read file contents\n\nGuidelines:\n- Use read to examine files instead of cat or sed.\n\nPi documentation (read only when the user asks about pi):\n- Main documentation: /r/README.md\n- Additional docs: /r/docs\n- Examples: /r/examples' }));
	const again = transformSystemPrompt(makeInput({ systemPrompt: once.systemPrompt }));
	assert.equal(again.systemPrompt, once.systemPrompt, 'second pass must be a no-op');
	assert.match(again.diagnostics[0], /already-transformed/);
});

// ---- 集成用例：走真实 Pi 0.84.4 的 buildSystemPrompt ------------------------

test('real Pi builder: default layout is transformed', { skip: !builderEntry }, async () => {
	const { buildSystemPrompt } = await import(pathToFileURL(builderEntry).href);
	const version = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).version;
	// 该测试对 0.84.x 的默认布局敏感；大版本漂移时先在这里报警。
	assert.match(version, /^0\.84\./, `unexpected Pi version ${version}`);

	for (const contextFiles of [
		[],
		[{ path: '/project/AGENTS.md', content: 'Guidelines:\r\nDO NOT TOUCH\r\nPi documentation (example)' }],
	]) {
		for (const appendSystemPrompt of [undefined, 'User-owned appended instructions']) {
			const options = {
				cwd: '/project',
				selectedTools: ['read'],
				toolSnippets: { read: 'Read file contents' },
				promptGuidelines: ['Use read to examine files instead of cat or sed.'],
				contextFiles,
				appendSystemPrompt,
			};
			const input = buildSystemPrompt(options);
			const result = transformSystemPrompt(makeInput({ systemPrompt: input, options, tools: defaultTools(), activeTools: ['read'] }));

			assert.notEqual(result.systemPrompt, input, result.diagnostics.join('; '));
			assert.match(result.systemPrompt, /You are Pi,/);
			// 文档块被移除，但用户自有的 context/append 必须原样保留
			assert.doesNotMatch(result.systemPrompt, /- Main documentation:/);
			assert.ok(result.systemPrompt.endsWith('Current working directory: /project'));
			for (const file of contextFiles) assert.ok(result.systemPrompt.includes(file.content));
			if (appendSystemPrompt) assert.ok(result.systemPrompt.includes(appendSystemPrompt));
		}
	}
});

test('real Pi builder: customPrompt path stays unmodified end-to-end', { skip: !builderEntry }, async () => {
	const { buildSystemPrompt } = await import(pathToFileURL(builderEntry).href);
	const customPrompt = 'You are a compact subagent for this repo.\n- stay focused';
	const options = { cwd: '/project', selectedTools: ['read', 'edit'], toolSnippets: { read: 'Read file contents', edit: 'Edit files' }, customPrompt, appendSystemPrompt: 'Extra child note' };
	const input = buildSystemPrompt(options);
	const result = transformSystemPrompt(makeInput({ systemPrompt: input, options, tools: defaultTools(), activeTools: ['read'] }));
	// 关键：即便结构里有 "Current working directory"，customPrompt 也要整体让路
	assert.equal(result.systemPrompt, input, result.diagnostics.join('; '));
	assert.match(result.diagnostics[0], /custom-or-child-prompt/);
	assert.ok(result.systemPrompt.includes(customPrompt));
});
