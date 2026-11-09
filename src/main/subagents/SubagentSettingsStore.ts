/**
 * 子代理偏好读写（pi settings.json 的 `subagents` 块）。
 *
 * 归属边界：模型/档位/委派偏好的**语义**属于 pideck-q-subagents 扩展，扩展从
 * `settings.json` 的 `subagents.defaultModel / defaultProvider / defaultThinking /
 * preferDelegation` 读取；PiDeck 只提供图形化编辑，不复制一份自己的配置，
 * 避免两处状态漂移。
 *
 * 写入约束：只 patch `subagents` 块内的上述四个键，其余顶层键与 `subagents`
 * 下的其它配置（agentOverrides / disableBuiltins / modelScope 等）原样保留。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../utils/atomicWriteFile";
import type {
	SubagentModelChoice,
	SubagentSettings,
	SubagentSettingsScope,
} from "../../shared/types";

/** 与扩展 parseThinkingLevel 接受的值保持一致；写入前拦截非法档位。 */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** pi settings.json 里的 subagents 块（只声明本模块读写的键，其余按 unknown 保留）。 */
type SubagentsBlock = Record<string, unknown>;

type Logger = {
	info(scope: string, message: string, detail?: unknown): unknown;
	warn(scope: string, message: string, detail?: unknown): unknown;
};

export type SubagentSettingsStoreDeps = {
	/** pi 全局配置目录（WSL 场景由 ConfigManager 切换），settings.json 位于其下。 */
	getConfigDir: () => string;
	/** 项目根路径；未知项目返回 undefined。 */
	getProjectPath: (projectId: string) => string | undefined;
	logger?: Logger;
};

const EMPTY_SETTINGS: SubagentSettings = { useOwnModel: false, preferDelegation: false };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 写盘：模型写成 `provider/id` 全限定形式。
 *
 * 模型 id 自带斜杠时（OpenRouter 的 `anthropic/claude-sonnet-4`），只写裸 id 会被扩展
 * 解析成「anthropic provider + claude-sonnet-4」，落到另一个 provider 的同名模型上；
 * 全限定形式直接命中 fullId 精确匹配，provider 不会串。
 */
function qualifiedModelId(model: SubagentModelChoice): string {
	return model.provider ? `${model.provider}/${model.modelId}` : model.modelId;
}

/** 读盘：去掉与 defaultProvider 重复的限定前缀，渲染层统一用裸 modelId。 */
function bareModelId(defaultModel: string, provider: string | undefined): string {
	const prefix = provider ? `${provider}/` : "";
	return prefix && defaultModel.startsWith(prefix) ? defaultModel.slice(prefix.length) : defaultModel;
}

/** settings.json 的 subagents 块 → 渲染层快照（只读已知键，损坏值按缺省处理）。 */
export function readSubagentSettings(settings: unknown): SubagentSettings {
	if (!isRecord(settings)) return { ...EMPTY_SETTINGS };
	const block = settings.subagents;
	if (!isRecord(block)) return { ...EMPTY_SETTINGS };
	const rawModelId = nonEmptyString(block.defaultModel);
	const provider = nonEmptyString(block.defaultProvider);
	// 手写的裸 id 与 PiDeck 写的全限定 id 都要能读：统一还原成裸 modelId。
	const modelId = rawModelId ? bareModelId(rawModelId, provider) : undefined;
	const thinkingLevel = nonEmptyString(block.defaultThinking);
	return {
		// defaultModel 是「子代理用独立模型」的唯一判据：只有 provider 没有模型时
		// 扩展仍然继承主代理模型，不能算开启。
		useOwnModel: Boolean(modelId),
		...(modelId
			? {
				model: {
					provider: provider ?? "",
					modelId,
					...(thinkingLevel ? { thinkingLevel } : {}),
				},
			}
			: {}),
		preferDelegation: block.preferDelegation === true,
	};
}

/**
 * 把一份偏好合入 settings.json 的 subagents 块。
 *
 * 关闭「独立模型」时删除三个模型键（恢复继承主代理），但**只在文件里本来就有
 * defaultModel 时**才删：defaultProvider / defaultThinking 是扩展文档里独立生效的
 * 设置（例如只给裸 model id 指定 provider、或统一给所有子代理设档位），用户手写过、
 * 弹框里根本没碰过开关时，不能因为保存「优先委派」就顺手清掉。
 *
 * 关闭「优先委派」时删除 preferDelegation。其它键（agentOverrides 等）保持不动；
 * 块变空时整块删除。
 */
export function applySubagentSettings(
	settings: unknown,
	next: SubagentSettings,
): Record<string, unknown> {
	const base = isRecord(settings) ? { ...settings } : {};
	const block: SubagentsBlock = isRecord(base.subagents) ? { ...base.subagents } : {};
	// 文件里是否本来就有「独立模型」配置：决定关闭开关时该不该清空三个模型键。
	// 用「键存在」而不是「值有效」判断：defaultModel 写成空串/数字时扩展会直接抛错，
	// 弹框显示为关闭，保存时应当把这个坏键清掉（否则扩展一直起不来）。
	const hadOwnModel = "defaultModel" in block;

	if (next.useOwnModel && next.model?.modelId) {
		block.defaultModel = qualifiedModelId(next.model);
		if (next.model.provider) block.defaultProvider = next.model.provider;
		else delete block.defaultProvider;
		if (next.model.thinkingLevel) block.defaultThinking = next.model.thinkingLevel;
		else delete block.defaultThinking;
	} else if (hadOwnModel) {
		delete block.defaultModel;
		delete block.defaultProvider;
		delete block.defaultThinking;
	}

	if (next.preferDelegation) block.preferDelegation = true;
	else delete block.preferDelegation;

	if (Object.keys(block).length > 0) base.subagents = block;
	else delete base.subagents;
	return base;
}

/** 校验渲染层提交的偏好；非法输入直接拒绝，不写盘。 */
export function validateSubagentSettings(value: unknown): SubagentSettings {
	if (!isRecord(value)) throw new Error("subagents settings must be an object");
	if (typeof value.useOwnModel !== "boolean") throw new Error("useOwnModel must be a boolean");
	if (typeof value.preferDelegation !== "boolean") throw new Error("preferDelegation must be a boolean");

	let model: SubagentModelChoice | undefined;
	if (value.model !== undefined) {
		if (!isRecord(value.model)) throw new Error("model must be an object");
		const modelId = nonEmptyString(value.model.modelId);
		if (!modelId) throw new Error("model.modelId must be a non-empty string");
		const provider = nonEmptyString(value.model.provider);
		const thinkingLevel = nonEmptyString(value.model.thinkingLevel);
		if (thinkingLevel && !THINKING_LEVELS.has(thinkingLevel)) {
			throw new Error(`model.thinkingLevel must be one of ${[...THINKING_LEVELS].join(", ")}`);
		}
		model = {
			provider: provider ?? "",
			modelId,
			...(thinkingLevel ? { thinkingLevel } : {}),
		};
	}
	// 开启独立模型却没有模型：拒绝，避免静默写出一份「开着但不生效」的配置。
	if (value.useOwnModel && !model) throw new Error("model is required when useOwnModel is true");

	return {
		useOwnModel: value.useOwnModel,
		...(model ? { model } : {}),
		preferDelegation: value.preferDelegation,
	};
}

export class SubagentSettingsStore {
	constructor(private readonly deps: SubagentSettingsStoreDeps) {}

	/** 全局 settings.json 路径（WSL 下由 ConfigManager 指向 WSL HOME）。 */
	private globalSettingsPath(): string {
		return join(this.deps.getConfigDir(), "settings.json");
	}

	/** 项目 settings.json 路径；无项目或路径未知时返回 undefined。 */
	private projectSettingsPath(projectId: string): string | undefined {
		const projectPath = this.deps.getProjectPath(projectId);
		return projectPath ? join(projectPath, ".pi", "settings.json") : undefined;
	}

	private async readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
		try {
			const raw = await readFile(filePath, "utf8");
			const parsed: unknown = JSON.parse(raw);
			return isRecord(parsed) ? parsed : {};
		} catch (error) {
			// 文件不存在是正常情况（首次配置）；其它错误（权限/JSON 损坏）必须暴露，
			// 否则会把「读不到」当成「没配置」写回一份空配置覆盖用户文件。
			if (isRecord(error) && error.code === "ENOENT") return {};
			throw error;
		}
	}

	/** 读取两个作用域；项目作用域在无项目时为 null。 */
	async read(projectId?: string): Promise<{ global: SubagentSettings; project: SubagentSettings | null }> {
		const global = readSubagentSettings(await this.readSettingsFile(this.globalSettingsPath()));
		const projectPath = projectId ? this.projectSettingsPath(projectId) : undefined;
		const project = projectPath
			? readSubagentSettings(await this.readSettingsFile(projectPath))
			: null;
		return { global, project };
	}

	/** 写入指定作用域；只 patch subagents 块。 */
	async save(
		scope: SubagentSettingsScope,
		projectId: string | undefined,
		next: SubagentSettings,
	): Promise<void> {
		const filePath = scope === "global"
			? this.globalSettingsPath()
			: (projectId ? this.projectSettingsPath(projectId) : undefined);
		if (!filePath) throw new Error("project settings require a known project");

		const current = await this.readSettingsFile(filePath);
		const merged = applySubagentSettings(current, next);
		// 原子写：settings.json 同时被 pi 读取，写一半崩溃会让 pi 启动失败。
		// 格式与 pi 自身一致（2 空格缩进 + 末尾换行），减少无谓 diff。
		await writeFileAtomic(filePath, `${JSON.stringify(merged, null, 2)}\n`);
		void this.deps.logger?.info("subagents", "Subagent settings saved", {
			scope,
			projectId,
			useOwnModel: next.useOwnModel,
			preferDelegation: next.preferDelegation,
		});
	}
}

export { EMPTY_SETTINGS as EMPTY_SUBAGENT_SETTINGS };
