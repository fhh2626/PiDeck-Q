/**
 * pi-deck-vision 扩展纯逻辑测试。
 *
 * 通过 ts.transpileModule + vm 沙箱加载扩展源码（与 agentTodoList.test.mjs 同套路），
 * node: 内置模块走真实 require，pi 类型导入 stub 为空对象。
 * 测行为不测实现：只断言配置解析、图片收集、替换、端点解析、请求构造、响应解析。
 */
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { trackedTempDirs } from "./helpers/trackedTempDirs.mjs";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

const EXT_PATH = "resources/extensions/pi-deck-vision.ts";

/** 沙箱内 fetch 的可替换 stub（describeImage 测试用）。 */
let fetchStub;

function compile(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => {
		if (specifier.startsWith("node:")) return require(specifier);
		// undici 的 fetch 由测试注入（describeImage 测试前必须替换 fetchStub），
		// 与全局 fetch 注入等价，但验证的是扩展走显式 dispatcher 的路径
		if (specifier === "undici") {
			return { Agent: class {}, fetch: (...args) => fetchStub(...args) };
		}
		return {};
	};
	// fetch 由测试注入，describeImage 测试前必须替换 fetchStub
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: localRequire,
		console,
		process,
		Buffer,
		setTimeout,
		clearTimeout,
		fetch: (...args) => fetchStub(...args),
		AbortController,
	}, { filename: filePath });
	return module.exports;
}

const makeTempDir = trackedTempDirs();
const ext = compile(EXT_PATH);

/** 临时配置目录 + 写入 pi-deck-vision.json，返回目录路径。 */
function makeConfigDir(partial) {
	const dir = makeTempDir("vision-test-");
	writeFileSync(join(dir, "pi-deck-vision.json"), JSON.stringify(partial, null, 2));
	return dir;
}

const imageA = { type: "image", data: "AAAA", mimeType: "image/png" };
const imageB = { type: "image", data: "BBBB", mimeType: "image/jpeg" };

// ── 配置读取 ─────────────────────────────────────────────

test("resolveConfigDir: env override wins, default is ~/.pi/agent", () => {
	const prev = process.env.PIDECK_VISION_CONFIG_DIR;
	try {
		process.env.PIDECK_VISION_CONFIG_DIR = "/custom/dir";
		assert.equal(ext.resolveConfigDir(), "/custom/dir");
		delete process.env.PIDECK_VISION_CONFIG_DIR;
		assert.ok(ext.resolveConfigDir().endsWith(join(".pi", "agent")));
	} finally {
		if (prev === undefined) delete process.env.PIDECK_VISION_CONFIG_DIR;
		else process.env.PIDECK_VISION_CONFIG_DIR = prev;
	}
});

test("loadVisionBridgeConfig: parses file and merges defaults", async () => {
	const dir = makeConfigDir({ provider: "glm", model: "glm-4v-flash" });
	const config = await ext.loadVisionBridgeConfig(dir);
	assert.equal(config.provider, "glm");
	assert.equal(config.model, "glm-4v-flash");
	// 未填字段落到默认值
	assert.equal(config.enabled, true);
	assert.equal(config.maxTokens, 0);
	assert.equal(config.timeoutMs, 120_000);
	assert.equal(config.concurrency, 2);
	assert.ok(config.promptTemplate.length > 0);
});

test("loadVisionBridgeConfig: missing file returns null", async () => {
	const dir = makeTempDir("vision-test-");
	assert.equal(await ext.loadVisionBridgeConfig(dir), null);
});

test("loadVisionBridgeConfig: invalid json returns null", async () => {
	const dir = makeTempDir("vision-test-");
	writeFileSync(join(dir, "pi-deck-vision.json"), "{ not json");
	assert.equal(await ext.loadVisionBridgeConfig(dir), null);
});

test("loadVisionBridgeConfig: explicit overrides survive merge", async () => {
	const dir = makeConfigDir({
		provider: "openai",
		model: "gpt-4o-mini",
		enabled: false,
		apiKey: "sk-test",
		baseUrl: "https://example.com/v1",
		maxTokens: 512,
		concurrency: 1,
	});
	const config = await ext.loadVisionBridgeConfig(dir);
	assert.equal(config.enabled, false);
	assert.equal(config.apiKey, "sk-test");
	assert.equal(config.baseUrl, "https://example.com/v1");
	assert.equal(config.maxTokens, 512);
	assert.equal(config.concurrency, 1);
});

test("imageHash: same data same hash, different data different hash", () => {
	assert.equal(ext.imageHash("AAAA"), ext.imageHash("AAAA"));
	assert.notEqual(ext.imageHash("AAAA"), ext.imageHash("BBBB"));
	assert.match(ext.imageHash("x"), /^[0-9a-f]{24}$/);
});

// ── 图片收集 ─────────────────────────────────────────────

// ── 图片提取与 note 替换 ──────────────────────────────────────

test("extractImageFromDataUrl: parses valid data url", () => {
	const image = ext.extractImageFromDataUrl('data:image/png;base64,QUFBQQ==');
	assert.equal(image.type, 'image');
	assert.equal(image.data, 'QUFBQQ==');
	assert.equal(image.mimeType, 'image/png');
});

test("extractImageFromDataUrl: rejects invalid urls", () => {
	assert.equal(ext.extractImageFromDataUrl('https://example.com/a.png'), null);
	assert.equal(ext.extractImageFromDataUrl('data:image/png;base64,!!not-base64!!'), null);
	assert.equal(ext.extractImageFromDataUrl(''), null);
});

test("replaceNoteInToolContent: replaces non-vision note with description", () => {
	const content = 'Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]';
	const next = ext.replaceNoteInToolContent(content, '[图片 #1（视觉桥已查看，以下为图片实际内容）]\n一只猫');
	assert.ok(next.startsWith('Read image file [image/png]'), '保留 read 前缀');
	assert.ok(next.includes('一只猫'));
	assert.ok(!next.includes('does not support images'), '误导性 note 已删除');
	assert.ok(next.includes('视觉桥已查看'));
});

test("replaceNoteInToolContent: keeps trailing content (acp tags) after note", () => {
	const content = 'Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]\n\n<acp tokens="29" type="read">m00003</acp>';
	const next = ext.replaceNoteInToolContent(content, '一只猫');
	assert.ok(next.includes('一只猫'));
	assert.ok(next.includes('<acp tokens'), 'note 之后的附加内容原样保留');
	assert.ok(!next.includes('does not support images'));
});

test("replaceNoteInToolContent: unrelated text stays untouched", () => {
	const content = 'Read image file [image/png]\n尺寸 512x512';
	assert.equal(ext.replaceNoteInToolContent(content, '一只猫'), content);
});

test("replaceNoteInToolContent: bare note form also replaced", () => {
	const content = 'Read image file [image/png]\nCurrent model does not support images. The image will be omitted from this request.';
	const next = ext.replaceNoteInToolContent(content, '一只猫');
	assert.ok(next.includes('一只猫'));
	assert.ok(!next.includes('does not support images'));
});

// ── 端点解析 ─────────────────────────────────────────────

function mockRegistry({ auth = {}, keys = {}, providers = {} } = {}) {
	// auth 值按 pi 0.8x 的 AuthResult 结构传：{ auth: ModelAuth, env?, source? }
	return {
		modelRegistry: {
			getProviderAuth: async (p) => auth[p],
			getApiKeyForProvider: async (p) => keys[p],
			getProvider: (p) => providers[p],
		},
	};
}


test("resolveEndpoint: explicit config wins without registry", async () => {
	const config = {
		provider: "glm",
		model: "glm-4v-flash",
		apiKey: "sk-explicit",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
	};
	const ctx = mockRegistry();
	const endpoint = await ext.resolveEndpoint(config, ctx);
	assert.equal(endpoint.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
	assert.equal(endpoint.apiKey, "sk-explicit");
	assert.equal(endpoint.model, "glm-4v-flash");
	assert.equal(endpoint.api, "openai-completions");
});

test("resolveEndpoint: falls back to registry auth", async () => {
	const config = { provider: "openai", model: "gpt-4o-mini" };
	// pi 0.8x AuthResult 结构：key/baseUrl 在 auth 子对象（旧扁平结构会导致取值落空）
	const ctx = mockRegistry({
		auth: { openai: { auth: { apiKey: "sk-registry", baseUrl: "https://registry.example.com/v1" } } },
	});
	const endpoint = await ext.resolveEndpoint(config, ctx);
	assert.equal(endpoint.apiKey, "sk-registry");
	assert.equal(endpoint.baseUrl, "https://registry.example.com/v1");
});

test("resolveEndpoint: openai default baseUrl when registry has none", async () => {
	const config = { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-x" };
	const endpoint = await ext.resolveEndpoint(config, mockRegistry());
	assert.equal(endpoint.baseUrl, "https://api.openai.com/v1");
});

test("resolveEndpoint: unknown provider without baseUrl returns null", async () => {
	const config = { provider: "my-custom", model: "m" };
	const ctx = mockRegistry({ keys: { "my-custom": "sk-x" } });
	assert.equal(await ext.resolveEndpoint(config, ctx), null);
});

test("resolveEndpoint: empty provider/model returns null", async () => {
	assert.equal(await ext.resolveEndpoint({ provider: "", model: "" }, mockRegistry()), null);
});

test("resolveEndpoint: anthropic provider api auto-detected", async () => {
	const config = { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-ant" };
	const ctx = mockRegistry({ providers: { anthropic: { api: "anthropic-messages" } } });
	const endpoint = await ext.resolveEndpoint(config, ctx);
	assert.equal(endpoint.api, "anthropic-messages");
});

test("resolveEndpoint: explicit api overrides provider type", async () => {
	const config = { provider: "anthropic", model: "claude-3-5-sonnet-latest", api: "openai-completions", apiKey: "sk-ant" };
	const endpoint = await ext.resolveEndpoint(config, mockRegistry());
	assert.equal(endpoint.api, "openai-completions");
});

// ── 请求构造 ─────────────────────────────────────────────

test("buildVisionRequest: openai-completions shape", () => {
	const endpoint = {
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4o-mini",
		apiKey: "sk-test",
		api: "openai-completions",
	};
	const { url, headers, body } = ext.buildVisionRequest(endpoint, imageA, "描述", 1024, { reasoningEffortNone: false });
	assert.equal(url, "https://api.openai.com/v1/chat/completions");
	assert.equal(headers.authorization, "Bearer sk-test");
	assert.equal(body.model, "gpt-4o-mini");
	assert.equal(body.reasoning_effort, undefined, "默认不带 reasoning_effort");
	assert.equal(body.messages[0].content[1].type, "image_url");
	assert.ok(body.messages[0].content[1].image_url.url.startsWith("data:image/png;base64,"));
});

test("buildVisionRequest: reasoningEffortNone adds reasoning_effort none", () => {
	const endpoint = {
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4o-mini",
		apiKey: "sk-test",
		api: "openai-completions",
	};
	const { body } = ext.buildVisionRequest(endpoint, imageA, "描述", 1024, { reasoningEffortNone: true });
	assert.equal(body.reasoning_effort, "none");
});

test("buildVisionRequest: anthropic-messages shape", () => {
	const endpoint = {
		baseUrl: "https://api.anthropic.com",
		model: "claude-3-5-sonnet-latest",
		apiKey: "sk-ant",
		api: "anthropic-messages",
	};
	const { url, headers, body } = ext.buildVisionRequest(endpoint, imageA, "描述", 1024, { reasoningEffortNone: false });
	assert.equal(url, "https://api.anthropic.com/v1/messages");
	assert.equal(headers["x-api-key"], "sk-ant");
	assert.equal(headers["anthropic-version"], "2023-06-01");
	assert.equal(body.messages[0].content[1].source.type, "base64");
	assert.equal(body.messages[0].content[1].source.media_type, "image/png");
});

test("buildVisionRequest: maxTokens 0 (unlimited) omits the field per format", () => {
	const openai = {
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4o-mini",
		apiKey: "sk-test",
		api: "openai-completions",
	};
	const openaiBody = ext.buildVisionRequest(openai, imageA, "描述", 0, { reasoningEffortNone: false }).body;
	assert.equal(openaiBody.max_tokens, undefined, "不限制时不传 max_tokens");

	const anthropic = {
		baseUrl: "https://api.anthropic.com",
		model: "claude-3-5-sonnet-latest",
		apiKey: "sk-ant",
		api: "anthropic-messages",
	};
	const anthropicBody = ext.buildVisionRequest(anthropic, imageA, "描述", 0, { reasoningEffortNone: false }).body;
	assert.equal(anthropicBody.max_tokens, 1024, "Anthropic 必填，不限制时兜底 1024");

	const gemini = {
		baseUrl: "https://generativelanguage.googleapis.com",
		model: "gemini-2.0-flash",
		apiKey: "gem-key",
		api: "google-generative-ai",
	};
	const geminiBody = ext.buildVisionRequest(gemini, imageA, "描述", 0, { reasoningEffortNone: false }).body;
	assert.equal(geminiBody.generationConfig, undefined, "不限制时不传 generationConfig/maxOutputTokens");
});

test("buildVisionRequest: google-generative-ai shape", () => {
	const endpoint = {
		baseUrl: "https://generativelanguage.googleapis.com",
		model: "gemini-2.0-flash",
		apiKey: "gem-key",
		api: "google-generative-ai",
	};
	const { url, body } = ext.buildVisionRequest(endpoint, imageA, "描述", 1024, { reasoningEffortNone: false });
	assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=gem-key");
	assert.equal(body.contents[0].parts[1].inline_data.mime_type, "image/png");
	assert.equal(body.generationConfig.maxOutputTokens, 1024);
});

// ── 响应解析 ─────────────────────────────────────────────

test("extractVisionText: openai-completions", () => {
	assert.equal(
		ext.extractVisionText("openai-completions", { choices: [{ message: { content: "猫" } }] }),
		"猫",
	);
	assert.equal(ext.extractVisionText("openai-completions", {}), "[empty response]");
});

test("extractVisionText: content array form (reasoning gateways)", () => {
	assert.equal(
		ext.extractVisionText("openai-completions", {
			choices: [{ message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] } }],
		}),
		"A\nB",
	);
});

test("extractVisionText: reasoning fallback only when enabled", () => {
	const payload = { choices: [{ message: { content: "", reasoning: "图片里是一只猫" } }] };
	assert.equal(ext.extractVisionText("openai-completions", payload), "[empty response]", "默认不回退 reasoning");
	assert.equal(
		ext.extractVisionText("openai-completions", payload, { fallbackToReasoning: true }),
		"图片里是一只猫",
		"显式开启后回退 reasoning",
	);
});

test("extractVisionText: anthropic-messages", () => {
	const payload = { content: [{ type: "text", text: "猫" }, { type: "text", text: "狗" }] };
	assert.equal(ext.extractVisionText("anthropic-messages", payload), "猫\n狗");
	assert.equal(ext.extractVisionText("anthropic-messages", {}), "[empty response]");
});

test("extractVisionText: google-generative-ai", () => {
	const payload = { candidates: [{ content: { parts: [{ text: "猫" }] } }] };
	assert.equal(ext.extractVisionText("google-generative-ai", payload), "猫");
	assert.equal(ext.extractVisionText("google-generative-ai", {}), "[empty response]");
});

// ── describeImage（重试路径） ─────────────────────────────

const endpointOpenAI = {
	baseUrl: "https://api.example.com/v1",
	model: "vision-model",
	apiKey: "sk-test",
	api: "openai-completions",
};

/** 构造响应对象：content 为空（思维链网关行为）时返回 reasoning，否则返回 content。
 * finishReason 可选（缺省不发 finish_reason 字段，模拟普通网关）。 */
function makeFetchStub(sequence) {
	const calls = [];
	fetchStub = async (url, opts) => {
		calls.push({ url, body: JSON.parse(opts.body) });
		const next = sequence[Math.min(calls.length - 1, sequence.length - 1)];
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				choices: [{
					message: next.includeReasoning
						? { content: "", reasoning: next.reasoning }
						: { content: next.content },
					...(next.finishReason ? { finish_reason: next.finishReason } : {}),
				}],
			}),
		};
	};
	return calls;
}

test("describeImage: retries with reasoning_effort none when content empty", async () => {
	const calls = makeFetchStub([
		{ content: "" },
		{ content: "图片里是一个绿色图标" },
	]);
	const result = await ext.describeImage(endpointOpenAI, imageA, "描述", { maxTokens: 1024, timeoutMs: 5000 });
	assert.equal(result.ok, true);
	assert.equal(result.text, "图片里是一个绿色图标");
	assert.equal(calls.length, 2, "空 content 触发一次重试");
	assert.equal(calls[0].body.reasoning_effort, undefined, "首次不带 reasoning_effort");
	assert.equal(calls[1].body.reasoning_effort, "none", "重试带 reasoning_effort:none");
	assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
});

test("describeImage: non-empty content makes single call", async () => {
	const calls = makeFetchStub([{ content: "猫" }]);
	const result = await ext.describeImage(endpointOpenAI, imageA, "描述", { maxTokens: 1024, timeoutMs: 5000 });
	assert.equal(result.ok, true);
	assert.equal(result.text, "猫");
	assert.equal(calls.length, 1);
});

test("describeImage: retry falls back to reasoning when still no content", async () => {
	const calls = makeFetchStub([
		{ content: "" },
		{ content: "", includeReasoning: true, reasoning: "图片里是一只猫（推理兜底）" },
	]);
	const result = await ext.describeImage(endpointOpenAI, imageA, "描述", { maxTokens: 1024, timeoutMs: 5000 });
	assert.equal(result.ok, true);
	assert.equal(result.text, "图片里是一只猫（推理兜底）");
	assert.equal(calls.length, 2);
});

test("describeImage: retries when answer truncated by length (thinking model)", async () => {
	// 思维链模型：max_tokens 被思考吃掉，回答被 length 截断（描述不完整）
	const calls = makeFetchStub([
		{ content: "1. 主体：沙发…", finishReason: "length" },
		{ content: "1. 主体：沙发。2. 窗户：落地窗。3. 窗外：城市景观。", finishReason: "stop" },
	]);
	const result = await ext.describeImage(endpointOpenAI, imageA, "描述", { maxTokens: 1024, timeoutMs: 5000 });
	assert.equal(result.ok, true);
	assert.equal(result.text, "1. 主体：沙发。2. 窗户：落地窗。3. 窗外：城市景观。");
	assert.equal(calls.length, 2, "length 截断触发一次重试");
	assert.equal(calls[0].body.reasoning_effort, undefined);
	assert.equal(calls[1].body.reasoning_effort, "none", "重试关闭思考");
});

test("describeImage: stops after one retry even if still truncated", async () => {
	// 防无限重试：重试后仍 length 截断时返回重试结果，不再发第三次请求
	const calls = makeFetchStub([
		{ content: "开头…", finishReason: "length" },
		{ content: "更完整的开头…", finishReason: "length" },
	]);
	const result = await ext.describeImage(endpointOpenAI, imageA, "描述", { maxTokens: 1024, timeoutMs: 5000 });
	assert.equal(result.ok, true);
	assert.equal(result.text, "更完整的开头…");
	assert.equal(calls.length, 2, "只重试一次");
});

test("describeImage: http error returns failure without throw", async () => {
	fetchStub = async () => ({ ok: false, status: 429, statusText: "Too Many Requests" });
	const result = await ext.describeImage(endpointOpenAI, imageA, "描述", { maxTokens: 1024, timeoutMs: 5000 });
	assert.equal(result.ok, false);
	assert.match(result.text, /429/);
});

test("describeImage: retries without max_tokens on 400 (low max_tokens limit gateway)", async () => {
	// 智谱 glm-4v-flash 类网关：max_tokens 上限低（[1,1024]），配置值超限返回 400。
	// 扩展应去掉 max_tokens 重试一次，成功后记住该端点。
	const calls = [];
	fetchStub = async (url, opts) => {
		const body = JSON.parse(opts.body);
		calls.push({ body });
		if (calls.length === 1) {
			return { ok: false, status: 400, statusText: "Bad Request", json: async () => ({}) };
		}
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ choices: [{ message: { content: "沙发图" } }] }),
		};
	};
	const result = await ext.describeImage(endpointOpenAI, imageA, "描述", { maxTokens: 2048, timeoutMs: 5000 });
	assert.equal(result.ok, true);
	assert.equal(result.text, "沙发图");
	assert.equal(calls.length, 2, "400 触发一次去 max_tokens 重试");
	assert.equal(calls[0].body.max_tokens, 2048, "首次带配置的 max_tokens");
	assert.equal(calls[1].body.max_tokens, undefined, "重试去掉 max_tokens");
});

// ── 0.8x 兼容 & 兜底 & 空响应 & 日志 ───────────────────────

test("replaceNoteInToolContent: new paren placeholder form (pi 0.8x)", () => {
	// pi 0.8x 的 tool 消息占位符是圆括号形式，旧正则不匹配会"走了但没换"
	const content =
		'Read image file [image/png]\n(tool image omitted: model does not support images)\n\n<acp tokens="29" type="read">m00003</acp>';
	const next = ext.replaceNoteInToolContent(content, "一只猫");
	assert.ok(next.startsWith("Read image file [image/png]"), "保留 read 前缀");
	assert.ok(next.includes("一只猫"));
	assert.ok(!next.includes("image omitted"), "新版占位符已删除");
	assert.ok(next.includes("<acp tokens"), "note 之后的 ACP 标签保留");
});

test("replaceNoteInToolContent: paren form without trailing content", () => {
	const content = "Read image file [image/png]\n(tool image omitted: model does not support images)";
	assert.equal(ext.replaceNoteInToolContent(content, "一只猫"), "Read image file [image/png]\n一只猫");
});

test("resolveEndpoint: falls back to model.baseUrl (builtin catalog model)", async () => {
	// pi 内置目录模型（opencode-go/mimo-v2.5 等）：baseUrl 挂在模型上，auth.json 里没有
	const config = { provider: "opencode-go", model: "mimo-v2.5" };
	const ctx = {
		modelRegistry: {
			getProviderAuth: async () => undefined,
			getApiKeyForProvider: async () => "sk-catalog",
			getProvider: () => undefined,
			find: (_p, m) => ({ id: m, provider: _p, baseUrl: "https://opencode.ai/zen/go/v1" }),
		},
	};
	const endpoint = await ext.resolveEndpoint(config, ctx);
	assert.equal(endpoint.baseUrl, "https://opencode.ai/zen/go/v1");
	assert.equal(endpoint.apiKey, "sk-catalog");
});

test("describeImage: empty response degrades to failure (not silent success)", async () => {
	// HTTP 200 但 content 空（重试后仍空）：必须降级为失败，不能把 "[empty response]"
	// 占位文本当成功描述喂给主模型（用户看到的就是"空响应"）
	const calls = [];
	fetchStub = async (_url, opts) => {
		const body = JSON.parse(opts.body);
		calls.push({ body });
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ choices: [{ message: { content: "" } }] }),
		};
	};
	const result = await ext.describeImage(endpointOpenAI, imageA, "描述", { maxTokens: 1024, timeoutMs: 5000 });
	assert.equal(result.ok, false, "两次都空响应必须降级为失败");
	assert.match(result.text, /空响应/);
	assert.equal(calls.length, 2, "空响应触发一次 reasoning_effort:none 重试");
	assert.equal(calls[1].body.reasoning_effort, "none");
});

test("writeVisionLog: uses local offset instead of UTC Z", async () => {
	const dir = makeConfigDir({ enabled: true });
	await ext.writeVisionLog(dir, "info", "time check");
	const content = readFileSync(join(dir, "pi-deck-vision.log"), "utf8");
	assert.match(content, /T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\]/);
	assert.doesNotMatch(content, /Z\]/);
});

test("writeVisionLog: appends entry to config dir", async () => {
	const dir = makeConfigDir({ enabled: true });
	await ext.writeVisionLog(dir, "warn", "input: 1 image(s) but vision bridge not configured");
	const content = readFileSync(join(dir, "pi-deck-vision.log"), "utf8");
	assert.match(content, /\[warn\] input: 1 image\(s\)/);
});

test("writeVisionLog: rotates oversized log keeping tail", async () => {
	const dir = makeConfigDir({ enabled: true });
	const big = "x".repeat(600 * 1024); // > 512KB 上限
	writeFileSync(join(dir, "pi-deck-vision.log"), big);
	await ext.writeVisionLog(dir, "info", "after rotate");
	const info = statSync(join(dir, "pi-deck-vision.log"));
	assert.ok(info.size <= 64 * 1024 + 200, "轮转后只保留尾部 64KB + 新行");
	assert.ok(readFileSync(join(dir, "pi-deck-vision.log"), "utf8").includes("after rotate"));
});

// ── 结构化转换事件（writeVisionEvent / describeImages 批次回调） ─────────

test("writeVisionEvent: appends a JSONL batch entry with full payload", async () => {
	const dir = makeConfigDir({ enabled: true });
	await ext.writeVisionEvent(dir, {
		ts: 1730000000000,
		kind: "input",
		model: "zhipu/glm-4v-flash",
		prompt: "描述这张图片",
		totalDurationMs: 1200,
		items: [
			{ index: 1, mimeType: "image/png", ok: true, durationMs: 800, cached: false, description: "一张截图", outputTokens: 42 },
			{ index: 2, mimeType: "image/jpeg", ok: false, error: "timeout(30000ms)", durationMs: 30000, cached: false },
		],
	});
	const line = readFileSync(join(dir, "pi-deck-vision-events.jsonl"), "utf8").trim();
	const parsed = JSON.parse(line);
	assert.equal(parsed.ts, 1730000000000);
	assert.equal(parsed.kind, "input");
	assert.equal(parsed.model, "zhipu/glm-4v-flash");
	assert.equal(parsed.prompt, "描述这张图片");
	assert.equal(parsed.totalDurationMs, 1200);
	assert.equal(parsed.items.length, 2);
	assert.equal(parsed.items[0].index, 1);
	assert.equal(parsed.items[0].ok, true);
	assert.equal(parsed.items[0].outputTokens, 42);
	assert.equal(parsed.items[1].error, "timeout(30000ms)");
});

test("writeVisionEvent: trims oversized file keeping the tail", async () => {
	const dir = makeConfigDir({ enabled: true });
	// 预写超过 MAX_EVENT_FILE_BYTES(2MB) 的行结构内容（真实事件文件每行是一条 JSON）
	const line = JSON.stringify({ ts: 1, kind: "input", model: "m/m", prompt: "p", totalDurationMs: 1, items: [] });
	const big = `${line}\n`.repeat(Math.ceil((2100 * 1024) / (line.length + 1)));
	writeFileSync(join(dir, "pi-deck-vision-events.jsonl"), big);
	await ext.writeVisionEvent(dir, {
		ts: 1730000000001,
		kind: "input",
		model: "m/m",
		prompt: "p",
		totalDurationMs: 1,
		items: [{ index: 1, mimeType: "image/png", ok: true, durationMs: 1, cached: false }],
	});
	const content = readFileSync(join(dir, "pi-deck-vision-events.jsonl"), "utf8");
	assert.ok(content.length < 1100 * 1024, "截断后只保留尾部约 1MB");
	assert.ok(content.endsWith("}\n"), "最后一行是新追加的事件");
	assert.ok(content.includes('"totalDurationMs":1'));
});

test("describeImages: onBatch reports per-image timing and results", async () => {
	// 用全新图片数据避免命中其他测试留下的模块级 descriptionCache
	const imageC = { type: "image", data: "CCCC", mimeType: "image/png" };
	const imageD = { type: "image", data: "DDDD", mimeType: "image/jpeg" };
	let callCount = 0;
	fetchStub = async (_url, opts) => {
		callCount++;
		const body = JSON.parse(opts.body);
		// 第一张图成功带 usage，第二张图 500 失败
		if (body.messages[0].content[1].image_url.url.includes("CCCC")) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					choices: [{ message: { content: "红色按钮的截图" } }],
					usage: { completion_tokens: 33 },
				}),
			};
		}
		return { ok: false, status: 500, statusText: "Server Error", json: async () => ({}) };
	};
	let batch = null;
	const desc = await ext.describeImages(
		endpointOpenAI,
		[imageC, imageD],
		"描述",
		{ enabled: true, provider: "zhipu", model: "glm-4v-flash" },
		undefined,
		undefined,
		(b) => { batch = b; },
	);
	assert.ok(desc.includes("视觉桥已查看"));
	assert.ok(batch, "onBatch 必须被调用");
	assert.equal(batch.items.length, 2);
	assert.equal(batch.items[0].index, 1);
	assert.equal(batch.items[0].imageHash, ext.imageHash("CCCC"), "事件带图片哈希供渲染层匹配实时消息");
	assert.equal(batch.items[1].imageHash, ext.imageHash("DDDD"));
	assert.equal(batch.items[0].ok, true);
	assert.equal(batch.items[0].description, "红色按钮的截图");
	assert.equal(batch.items[0].outputTokens, 33);
	assert.ok(batch.items[0].durationMs >= 0);
	assert.equal(batch.items[0].cached, false);
	assert.equal(batch.items[1].index, 2);
	assert.equal(batch.items[1].ok, false);
	assert.match(batch.items[1].error, /500/);
	assert.ok(batch.totalDurationMs >= 0);
	assert.equal(callCount, 2);
});

test("describeImage: success reports durationMs and outputTokens", async () => {
	fetchStub = async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({
			choices: [{ message: { content: "图表描述" } }],
			usage: { prompt_tokens: 800, completion_tokens: 120 },
		}),
	});
	const result = await ext.describeImage(endpointOpenAI, { type: "image", data: "EEEE", mimeType: "image/png" }, "描述", { maxTokens: 1024, timeoutMs: 5000 });
	assert.equal(result.ok, true);
	assert.equal(result.outputTokens, 120);
	assert.ok(typeof result.durationMs === "number" && result.durationMs >= 0);
});
