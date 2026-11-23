/**
 * 同步模型规格到 resources/model-specs.db（发版前运行）。
 *
 * 数据源：
 * - OpenRouter /api/v1/models：context_length、top_provider.max_completion_tokens、多模态
 * - models.dev/api.json（Anthropic 官方）：reasoning / tool_call / attachment / modalities
 *
 * 用法: node scripts/sync-model-specs.mjs [--proxy http://127.0.0.1:7890]
 * 代理优先级：--proxy 参数 > HTTPS_PROXY/HTTP_PROXY 环境变量（国内构建机拉不动时用）。
 * 输出: resources/model-specs.db（带 synced_at 同步时间与条数统计）。
 *
 * 运行期由 native/backend/domain/projects/ModelSpecs.cpp 只读加载；
 * 表结构变更需同步修改 store 的 SELECT 列。
 */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetch } from "undici";
import { ProxyAgent } from "undici";
import initSqlJs from "sql.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUTPUT_DB = join(ROOT, "resources", "model-specs.db");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const MODELS_DEV_URL = "https://models.dev/api.json";

/** 内置补充表：双源未收录的国产/长尾模型（手工维护）。
 * 来源标记 builtin，与 models-dev 同构（能力位）。
 * 添加依据：
 * - 商汤：llm-ring/lmring model-depot sensenova.ts（商汤大装置平台 API 模型卡，含能力标注）
 * - 阶跃星辰：platform.stepfun.com 官方模型页
 * context/max_tokens 官方未公开的型号留空（等用户手填）；更新时同步更新测试。 */
const BUILTIN_EXTRA_SPECS = [
	// ── 商汤日日新 SenseNova ──
	{
		// 原生多模态智能体（OpenAI Vision 兼容，URL/Base64），推理模型；OCR 与图表解析增强
		source: "builtin",
		provider: "sensenova",
		id: "sensenova-6.7-flash-lite",
		context_window: 262144,
		max_tokens: 65536,
		reasoning: 1,
		tool_call: 1,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image"]),
	},
	{
		// 6.7 系列标准版：官方卡标注 functionCall + reasoning（视觉未标，不填）
		source: "builtin",
		provider: "sensenova",
		id: "sensenova-6.7-flash",
		context_window: 262144,
		max_tokens: 65536,
		reasoning: 1,
		tool_call: 1,
		attachment: 0,
		input_modalities: JSON.stringify(["text"]),
	},
	{
		// V6.5 系列：多模态推理，128K 上下文，OCR/文旅 IP 识别专项
		source: "builtin",
		provider: "sensenova",
		id: "SenseNova-V6-5-Pro",
		context_window: 131072,
		max_tokens: null,
		reasoning: 1,
		tool_call: 0,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image"]),
	},
	{
		source: "builtin",
		provider: "sensenova",
		id: "SenseNova-V6-5-Turbo",
		context_window: 131072,
		max_tokens: null,
		reasoning: 1,
		tool_call: 0,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image"]),
	},
	{
		// V6 系列：图片/文本/视频原生统一
		source: "builtin",
		provider: "sensenova",
		id: "SenseNova-V6-Reasoner",
		context_window: 32768,
		max_tokens: null,
		reasoning: 1,
		tool_call: 0,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image"]),
	},
	{
		source: "builtin",
		provider: "sensenova",
		id: "SenseNova-V6-Turbo",
		context_window: 32768,
		max_tokens: null,
		reasoning: 0,
		tool_call: 0,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image"]),
	},
	{
		source: "builtin",
		provider: "sensenova",
		id: "SenseNova-V6-Pro",
		context_window: 32768,
		max_tokens: null,
		reasoning: 0,
		tool_call: 0,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image"]),
	},
	{
		// SenseChat 5.5：128K，functionCall
		source: "builtin",
		provider: "sensenova",
		id: "SenseChat-5",
		context_window: 131072,
		max_tokens: 131072,
		reasoning: 0,
		tool_call: 1,
		attachment: 0,
		input_modalities: JSON.stringify(["text"]),
	},
	{
		// 多图输入视觉模型
		source: "builtin",
		provider: "sensenova",
		id: "SenseChat-Vision",
		context_window: 16384,
		max_tokens: 16384,
		reasoning: 0,
		tool_call: 0,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image"]),
	},
	{
		source: "builtin",
		provider: "sensenova",
		id: "SenseChat-Turbo",
		context_window: 32768,
		max_tokens: 32768,
		reasoning: 0,
		tool_call: 1,
		attachment: 0,
		input_modalities: JSON.stringify(["text"]),
	},
	{
		// 历史遗留 id（平台仍提供）：SenseChat 4.0 系列与方言/角色模型
		source: "builtin",
		provider: "sensenova",
		id: "SenseChat-128K",
		context_window: 131072,
		max_tokens: 131072,
		reasoning: 0,
		tool_call: 0,
		attachment: 0,
		input_modalities: JSON.stringify(["text"]),
	},
	{
		source: "builtin",
		provider: "sensenova",
		id: "SenseChat-32K",
		context_window: 32768,
		max_tokens: 32768,
		reasoning: 0,
		tool_call: 0,
		attachment: 0,
		input_modalities: JSON.stringify(["text"]),
	},
	{
		source: "builtin",
		provider: "sensenova",
		id: "SenseChat",
		context_window: 4096,
		max_tokens: 4096,
		reasoning: 0,
		tool_call: 0,
		attachment: 0,
		input_modalities: JSON.stringify(["text"]),
	},
	{
		source: "builtin",
		provider: "sensenova",
		id: "SenseChat-5-Cantonese",
		context_window: 32768,
		max_tokens: 32768,
		reasoning: 0,
		tool_call: 0,
		attachment: 0,
		input_modalities: JSON.stringify(["text"]),
	},
	{
		source: "builtin",
		provider: "sensenova",
		id: "SenseChat-Character-Pro",
		context_window: 32768,
		max_tokens: 4096,
		reasoning: 0,
		tool_call: 0,
		attachment: 0,
		input_modalities: JSON.stringify(["text"]),
	},
	// ── 阶跃星辰 StepFun ──
	{
		// 视觉理解模型：图片/视频理解（官方，32K）；主流的 step-3.7-flash / step-3.5-flash 已由双源覆盖
		source: "builtin",
		provider: "stepfun",
		id: "step-1o-turbo-vision",
		context_window: 32768,
		max_tokens: null,
		reasoning: 0,
		tool_call: 0,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image"]),
	},
	// ── Kimi for Coding（Kimi Code 官方平台，code.kimi.com）──
	// 依据 kimi.com/code/docs 模型卡：k3 为 1M 上下文（原生多模态），k3-256k 为 256K 版本
	// （不支持视频输入）；kimi-for-coding / -highspeed 为 K2.7-Code 系列 256K。
	// models.dev 仅收录能力位（reasoning/tool_call/attachment）无上下文，这里补齐官方值。
	{
		source: "builtin",
		provider: "kimi-for-coding",
		id: "k3",
		context_window: 1048576,
		max_tokens: null,
		reasoning: 1,
		tool_call: 1,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image", "video"]),
	},
	{
		source: "builtin",
		provider: "kimi-for-coding",
		id: "k3-256k",
		context_window: 262144,
		max_tokens: null,
		reasoning: 1,
		tool_call: 1,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image"]),
	},
	{
		source: "builtin",
		provider: "kimi-for-coding",
		id: "kimi-for-coding",
		context_window: 262144,
		max_tokens: null,
		reasoning: 1,
		tool_call: 1,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image", "video"]),
	},
	{
		source: "builtin",
		provider: "kimi-for-coding",
		id: "kimi-for-coding-highspeed",
		context_window: 262144,
		max_tokens: null,
		reasoning: 1,
		tool_call: 1,
		attachment: 1,
		input_modalities: JSON.stringify(["text", "image", "video"]),
	},
];

function resolveProxy() {
	const args = process.argv.slice(2);
	const proxyIndex = args.indexOf("--proxy");
	if (proxyIndex >= 0 && args[proxyIndex + 1]) return args[proxyIndex + 1];
	return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined;
}

async function fetchJson(url, dispatcher) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const response = await fetch(url, { dispatcher, signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/** 裁剪 OpenRouter 响应：只保留填充需要的字段（由原生模型规格查询消费） */
function trimOpenRouter(data) {
	const out = [];
	for (const m of data ?? []) {
		if (typeof m?.id !== "string" || typeof m.context_length !== "number" || m.context_length <= 0) continue;
		out.push({
			source: "openrouter",
			provider: m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : null,
			id: m.id,
			context_window: m.context_length,
			max_tokens:
				typeof m.top_provider?.max_completion_tokens === "number"
					? m.top_provider.max_completion_tokens
					: null,
			reasoning: null,
			tool_call: null,
			attachment: null,
			input_modalities: JSON.stringify(
				Array.isArray(m.architecture?.input_modalities)
					? m.architecture.input_modalities.filter((x) => typeof x === "string")
					: [],
			),
		});
	}
	return out;
}

/** 裁剪 models.dev 响应：provider 嵌套展开 */
function trimModelsDev(json) {
	const out = [];
	for (const [provider, providerValue] of Object.entries(json ?? {})) {
		const models = providerValue?.models;
		if (!models || typeof models !== "object") continue;
		for (const [id, model] of Object.entries(models)) {
			if (!model || typeof model !== "object") continue;
			out.push({
				source: "models-dev",
				provider,
				id,
				context_window: null,
				max_tokens: null,
				reasoning: model.reasoning === true ? 1 : null,
				tool_call: model.tool_call === true ? 1 : null,
				attachment: model.attachment === true ? 1 : null,
				input_modalities: JSON.stringify(
					Array.isArray(model.modalities?.input)
						? model.modalities.input.filter((x) => typeof x === "string")
						: [],
				),
			});
		}
	}
	return out;
}

async function main() {
	const proxy = resolveProxy();
	const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
	if (proxy) console.log(`使用代理: ${proxy}`);

	console.log(`拉取 OpenRouter（${OPENROUTER_URL}）…`);
	const [openrouterJson, modelsDevJson] = await Promise.all([
		fetchJson(OPENROUTER_URL, dispatcher),
		fetchJson(MODELS_DEV_URL, dispatcher),
	]);

	const openrouterRows = trimOpenRouter(openrouterJson?.data);
	const modelsDevRows = trimModelsDev(modelsDevJson);
	if (openrouterRows.length === 0 && modelsDevRows.length === 0) {
		console.error("双源均拉取/解析失败，不生成 db（保留旧文件）");
		process.exit(1);
	}
	console.log(`OpenRouter ${openrouterRows.length} 条，models.dev ${modelsDevRows.length} 条，内置补充 ${BUILTIN_EXTRA_SPECS.length} 条`);

	const SQL = await initSqlJs();
	const db = new SQL.Database();
	db.run(`
		CREATE TABLE IF NOT EXISTS model_specs (
			source TEXT NOT NULL,
			provider TEXT,
			id TEXT NOT NULL,
			context_window INTEGER,
			max_tokens INTEGER,
			reasoning INTEGER,
			tool_call INTEGER,
			attachment INTEGER,
			input_modalities TEXT
		)
	`);
	db.run(`CREATE INDEX IF NOT EXISTS idx_model_specs_id ON model_specs(id)`);
	db.run(`
		CREATE TABLE IF NOT EXISTS model_specs_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);

	const insert = db.prepare(
		`INSERT INTO model_specs
		 (source, provider, id, context_window, max_tokens, reasoning, tool_call, attachment, input_modalities)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	db.run("BEGIN TRANSACTION");
	for (const row of [...openrouterRows, ...modelsDevRows, ...BUILTIN_EXTRA_SPECS]) {
		insert.run([
			row.source,
			row.provider,
			row.id,
			row.context_window,
			row.max_tokens,
			row.reasoning,
			row.tool_call,
			row.attachment,
			row.input_modalities,
		]);
	}
	db.run("COMMIT");

	// 同步时间与统计：UI 层展示「数据同步于 …」，也用于核对发版数据的时效
	const syncedAt = new Date().toISOString();
	const upsertMeta = db.prepare(
		`INSERT OR REPLACE INTO model_specs_meta (key, value) VALUES (?, ?)`,
	);
	for (const [key, value] of [
		["synced_at", syncedAt],
		["openrouter_count", String(openrouterRows.length)],
		["models_dev_count", String(modelsDevRows.length)],
		["builtin_count", String(BUILTIN_EXTRA_SPECS.length)],
		["schema_version", "1"],
	]) {
		upsertMeta.run([key, value]);
	}

	const bytes = db.export();
	mkdirSync(dirname(OUTPUT_DB), { recursive: true });
	writeFileSync(OUTPUT_DB, Buffer.from(bytes));
	const sizeKB = (statSync(OUTPUT_DB).size / 1024).toFixed(0);
	console.log(`已生成 ${OUTPUT_DB}（${sizeKB}KB，同步于 ${syncedAt}）`);
	console.log(`发版提醒：确认 package.json extraResources 含 "resources/model-specs.db" 的映射。`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
