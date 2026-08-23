/**
 * 模型规格存储：context window / 输出上限 / 推理 / 视觉能力。
 *
 * 数据来源：resources/model-specs.db（SQLite，sql.js 读取），由发版前
 * scripts/sync-model-specs.mjs 从线上同步生成（OpenRouter + models.dev 双源，
 * 按「模型 id」匹配——与用户走什么中转站 baseUrl 无关，中转站模型 id 与
 * 官方一致即可命中）。表内带 synced_at 同步时间，发版前跑一次脚本即可更新。
 *
 * 为什么用 SQLite 而不是运行时拉取：包内数据 + 零网络依赖，查询毫秒级；
 * 双源裁剪后 gzip 仅 ~49KB，打包体积可忽略（对比 xueprompts.db 4.11MB）。
 *
 * 查询优先级由 UI 层决定：本 store 查不到时，调用方可兜底 pi --list-models。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js";
import type { ModelSpec } from "../../shared/types/modelSpecs";
import { buildSpecIndex, lookupModelSpec } from "./modelSpecsIndex";
import type { ModelsDevSpecEntry, OpenRouterSpecEntry } from "./modelSpecsIndex";

/** db 行（model_specs 表，与 sync-model-specs.mjs 建表结构一致） */
export type ModelSpecRow = {
	source: string;
	provider: string | null;
	id: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: number | null;
	toolCall: number | null;
	attachment: number | null;
	inputModalities: string | null;
};

/** 解析 db 行 → 双源条目（纯函数，可单测；兼容 NULL/缺失字段的旧数据） */
export function entriesFromRows(rows: ModelSpecRow[]): {
	openrouter: OpenRouterSpecEntry[];
	modelsDev: ModelsDevSpecEntry[];
} {
	const openrouter: OpenRouterSpecEntry[] = [];
	const modelsDev: ModelsDevSpecEntry[] = [];
	for (const row of rows) {
		if (typeof row.id !== "string" || !row.id) continue;
		const inputModalities: string[] = [];
		if (typeof row.inputModalities === "string") {
			try {
				const parsed = JSON.parse(row.inputModalities) as unknown;
				if (Array.isArray(parsed)) {
					for (const item of parsed) if (typeof item === "string") inputModalities.push(item);
				}
			} catch {
				// 单行数据损坏不影响其余行
			}
		}
		if (row.source === "openrouter") {
			if (typeof row.contextWindow === "number" && row.contextWindow > 0) {
				openrouter.push({
					id: row.id,
					contextWindow: row.contextWindow,
					maxTokens: typeof row.maxTokens === "number" && row.maxTokens > 0 ? row.maxTokens : undefined,
					inputModalities,
				});
			}
		// builtin 与 models-dev 同构（能力位齐全、无 context）：双源未收录的国产/长尾模型走同一裸 id 命中路径；
		// builtin 行可携带 context/maxTokens（官方模型卡来源），透传给查询层合并
		} else if (row.source === "models-dev" || row.source === "builtin") {
			modelsDev.push({
				provider: row.provider ?? "",
				id: row.id,
				// 保留数据源：builtin 为官方权威行（合并时能力位直接覆盖）
				source: row.source,
				contextWindow:
					typeof row.contextWindow === "number" && row.contextWindow > 0 ? row.contextWindow : undefined,
				maxTokens: typeof row.maxTokens === "number" && row.maxTokens > 0 ? row.maxTokens : undefined,
				reasoning: row.reasoning === 1 ? true : undefined,
				toolCall: row.toolCall === 1 ? true : undefined,
				// 0/1 语义保留：0 = 厂商显式声明不支持（合并时一票否决），1 = 支持
				attachment: row.attachment === 1 ? true : row.attachment === 0 ? false : undefined,
				inputModalities,
			});
		}
	}
	return { openrouter, modelsDev };
}

/** 缓存元信息（synced_at 等，来自 model_specs_meta 表） */
export type ModelSpecsInfo = {
	loaded: boolean;
	syncedAt?: string;
	openrouterCount?: number;
	modelsDevCount?: number;
};

/**
 * 只读模型规格存储：懒加载 sql.js → 全表读入 → 构建内存索引。
 * 数据随安装包分发，无网络依赖；加载失败返回 undefined（UI 维持现状）。
 */
export class ModelSpecsStore {
	private indexPromise: Promise<ReturnType<typeof buildSpecIndex> | null> | null = null;
	private info: ModelSpecsInfo = { loaded: false };

	constructor(
		private readonly dbPath: string,
		private readonly sqlLoader: typeof initSqlJs = initSqlJs,
		private readonly wasmLocateDir?: string,
		private readonly isPackaged = false,
	) {}

	/** 查询模型规格（懒加载索引；未命中返回 undefined） */
	async lookup(providerName: string, modelId: string): Promise<ModelSpec | undefined> {
		const index = await this.ensureIndex();
		return index ? lookupModelSpec(index, providerName, modelId) : undefined;
	}

	/** 缓存信息（UI 显示「数据同步于 …」） */
	getInfo(): ModelSpecsInfo {
		return this.info;
	}

	/** 后台预热：触发索引加载但不等待（调用方 void + catch） */
	warm(): void {
		void this.ensureIndex().catch(() => undefined);
	}

	private ensureIndex(): Promise<ReturnType<typeof buildSpecIndex> | null> {
		if (!this.indexPromise) {
			this.indexPromise = this.loadFromDb().catch((error) => {
				// 加载失败静默降级：查询返回 undefined，不阻断配置界面
				this.info = { loaded: false };
				// eslint-disable-next-line no-console
				console.error(`[model-specs] failed to load ${this.dbPath}:`, error);
				return null;
			});
		}
		return this.indexPromise;
	}

	private async loadFromDb(): Promise<ReturnType<typeof buildSpecIndex> | null> {
		if (!existsSync(this.dbPath)) return null;
		const SQL = await this.sqlLoader({
			locateFile: (file: string) => {
				// 打包后 sql-wasm.wasm 经 asarUnpack 解压，不能从 asar 内加载 WASM
				if (this.wasmLocateDir) {
					return join(this.wasmLocateDir, file);
				}
				return join(process.cwd(), "node_modules", "sql.js", "dist", file);
			},
		});
		const db = new SQL.Database(readFileSync(this.dbPath));

		const specRows = db.exec(
			`SELECT source, provider, id, context_window, max_tokens,
			        reasoning, tool_call, attachment, input_modalities
			 FROM model_specs`,
		);
		const rows: ModelSpecRow[] = (specRows[0]?.values ?? []).map((row: unknown[]) => ({
			source: String(row[0] ?? ""),
			provider: row[1] == null ? null : String(row[1]),
			id: String(row[2] ?? ""),
			contextWindow: row[3] == null ? null : Number(row[3]),
			maxTokens: row[4] == null ? null : Number(row[4]),
			reasoning: row[5] == null ? null : Number(row[5]),
			toolCall: row[6] == null ? null : Number(row[6]),
			attachment: row[7] == null ? null : Number(row[7]),
			inputModalities: row[8] == null ? null : String(row[8]),
		}));

		const metaRows = db.exec(`SELECT key, value FROM model_specs_meta`);
		const meta: Record<string, string> = {};
		for (const row of metaRows[0]?.values ?? []) {
			if (typeof row[0] === "string") meta[row[0]] = String(row[1] ?? "");
		}

		const { openrouter, modelsDev } = entriesFromRows(rows);
		this.info = {
			loaded: openrouter.length > 0 || modelsDev.length > 0,
			syncedAt: meta.synced_at || undefined,
			openrouterCount: openrouter.length,
			modelsDevCount: modelsDev.length,
		};
		db.close();
		return buildSpecIndex(openrouter, modelsDev);
	}
}
