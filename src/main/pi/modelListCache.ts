/**
 * pi --list-models 全局缓存模块。
 *
 * 数据源：pi --list-models（pi 内部处理 auth.json/models.json/内置目录，输出「可用模型」）。
 * 首选数据源是 implementation-neutral RPC；旧版/不完整 Pi 才退回文本表格。
 * TypeScript 文本 fallback 可用 --offline，Rust CLI 没有这个参数，不能共用。
 *
 * 刷新策略：
 * - 启动时异步预加载（应用 ready 后后台 fork 一次）；
 * - 界面保存 models.json/auth.json 后失效并后台重取；
 * - 每次启动 Agent 时强制重取（防用户直接改文件不生效）。
 */

import type { AvailableModel } from "../../shared/types";
import type { PiLocator } from "./PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PiRpcClient } from "./PiRpcClient";
import { normalizePiRpcModels } from "../../shared/piCompatibility";

/** 全局缓存：模型列表（null = 未加载/已失效） */
let cachedListModels: AvailableModel[] | null = null;
/** 在途请求去重：并发调用只 fork 一次 */
let cachedListModelsPending: Promise<AvailableModel[]> | null = null;
/**
 * 配置变更标记：invalidate 后在途请求的结果不得写缓存（其数据对应失效前的配置），
 * 否则保存 models.json 时若存在旧的在途 fork，旧结果会覆盖新缓存——
 * 表现为「新模型添加后下拉列表有时候没有」。refreshModelList 重取时复位。
 */
let configInvalidated = false;

/** pi --list-models 加速参数：offline 跳过网络目录刷新，no-ext/skills/themes 跳过发现加载。 */
export const MODEL_LIST_FAST_ARGS = [
	"--list-models",
	"--offline",
	"--no-extensions",
	"--no-skills",
	"--no-themes",
];

/** Rust fallback: keep the CLI flags shared by both implementations only. */
export const MODEL_LIST_RUST_ARGS = [
	"--list-models",
	"--no-extensions",
	"--no-skills",
	"--no-themes",
];

/** RPC is the stable model-list contract shared by the TypeScript and Rust implementations. */
export const MODEL_LIST_RPC_ARGS = [
	"--mode",
	"rpc",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-themes",
];

/**
 * 解析 pi --list-models 的文本表格输出。
 * 表格格式：provider  model  context  max-out  thinking  images
 * context/max-out 为人类可读 token 数（如 1M / 65.5K / 272K），解析为数字；
 * thinking/images 为 yes/no。
 * 关键：不能按空白切分前两列——provider 名可能含空格（如用户把 provider 复制为
 * "grok.weishiair.de copy"），split 后 token 数 > 列数。因此从右往左解析：
 * 后 4 列固定是 context/max-out/thinking/images（数值/yes/no 不含空格），
 * 倒数第 5 个 token 是模型 id，再往前的所有 token 拼回 provider 名。
 */
export function parsePiListModels(stdout: string): AvailableModel[] {
	const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length < 2) return [];
	// Rust may print diagnostics before the table; locate the header instead of
	// blindly assuming the first line is a header.
	const headerIndex = lines.findIndex((line) => /^provider\s+model\b/i.test(line));
	const dataLines = lines.slice(headerIndex >= 0 ? headerIndex + 1 : 1);
	const models: AvailableModel[] = [];
	const seen = new Set<string>();
	for (const line of dataLines) {
		const parts = line.split(/\s+/).filter(Boolean);
		if (parts.length < 3) continue;
		// Rust appends "Showing N of M providers..." after the rows. It is not a
		// model row; requiring a trailing yes/no pair rejects it safely.
		if (/^showing$/i.test(parts[0] ?? "")) continue;
		if (parts.length >= 6) {
			// 完整 6 列表格：后 4 列固定为 context/max-out/thinking/images；
			// provider 名可含空格，模型 id 之前的所有 token 拼回 provider
			const tail = parts.slice(-4);
			if (!isYesNo(tail[2]) || !isYesNo(tail[3])) continue;
			const provider = parts.slice(0, -5).join(" ");
			const modelId = parts[parts.length - 5];
			if (!provider || !modelId) continue;
			const key = `${provider}\u0000${modelId}`.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			models.push({
				provider,
				id: modelId,
				name: `${provider}/${modelId}`,
				contextWindow: parseTokenSize(tail[0] ?? ""),
				maxTokens: parseTokenSize(tail[1] ?? ""),
				reasoning: tail[2]?.toLowerCase() === "yes",
				images: tail[3]?.toLowerCase() === "yes",
			});
		} else {
			// 兼容旧格式（provider/model/thinking）：从右侧识别固定列，允许 provider 含空格。
			const thinking = parts[parts.length - 1];
			if (!isYesNo(thinking)) continue;
			const provider = parts.slice(0, -2).join(" ");
			const modelId = parts[parts.length - 2];
			if (!provider || !modelId) continue;
			const key = `${provider}\u0000${modelId}`.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			models.push({
				provider,
				id: modelId,
				name: `${provider}/${modelId}`,
				reasoning: thinking.toLowerCase() === "yes",
			});
		}
	}
	return models;
}

function isYesNo(value: string | undefined): boolean {
	return value?.toLowerCase() === "yes" || value?.toLowerCase() === "no";
}

/** 解析 pi 表格里的 token 数："1M"→1048576，"65.5K"→67109，"200K"→204800；解析失败返回 undefined。 */
export function parseTokenSize(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const match = /^([\d.]+)([KkMm])?$/.exec(trimmed);
	if (!match) return undefined;
	const num = Number(match[1]);
	if (!Number.isFinite(num) || num <= 0) return undefined;
	const unit = match[2]?.toLowerCase();
	if (unit === "k") return Math.round(num * 1024);
	if (unit === "m") return Math.round(num * 1024 * 1024);
	return Math.round(num);
}

/** Query the implementation-neutral RPC model list (一次调用，带超时). */
async function runPiRpcModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
	const settings = settingsStore.get();
	const command = piLocator.resolveCommand(
		settings.customPiPath,
		settings.wslEnabled,
		settings.wslDistro,
		settings.wslUser,
		settings.piRuntimePreference,
		settings.piTypescriptPath,
		settings.piRustPath,
		settings.piBoltPath,
	);
	const invocation = piLocator.createInvocation(command, MODEL_LIST_RPC_ARGS);
	const child = spawn(invocation.command, invocation.args, {
		env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
		shell: invocation.shell,
		windowsHide: true,
		windowsVerbatimArguments: invocation.windowsVerbatimArguments,
		stdio: ["pipe", "pipe", "pipe"],
	});
	// Startup diagnostics belong on stderr, never in the JSON-RPC stream. Drain
	// the pipe even though the model-list result only needs stdout.
	child.stderr.on("data", () => undefined);
	const client = new PiRpcClient(child.stdin, child.stdout);
	try {
		const response = await client.request({ type: "get_available_models" }, 20_000);
		if (!response.success) throw new Error(response.error ?? "get_available_models failed");
		return normalizePiRpcModels(response.data);
	} finally {
		client.close();
		stopModelListProcess(child);
	}
}

/** CLI text fallback for older/partial Pi builds that do not expose the RPC command. */
async function runPiTextModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
	const settings = settingsStore.get();
	const command = piLocator.resolveCommand(
		settings.customPiPath,
		settings.wslEnabled,
		settings.wslDistro,
		settings.wslUser,
		settings.piRuntimePreference,
		settings.piTypescriptPath,
		settings.piRustPath,
		settings.piBoltPath,
	);
	const { execFile } = await import("node:child_process");
	// The neutral set is valid for both implementations. Only an explicit
	// TypeScript-compatible selection (original Pi or Pi-Bolt) opts into --offline;
	// auto mode must stay safe when PATH resolves to Rust under the generic `pi` name.
	const argumentSets = settings.piRuntimePreference === "typescript" || settings.piRuntimePreference === "bolt"
		? [MODEL_LIST_FAST_ARGS, MODEL_LIST_RUST_ARGS]
		: [MODEL_LIST_RUST_ARGS];
	let lastError: Error | undefined;
	for (const args of argumentSets) {
		const invocation = piLocator.createInvocation(command, args);
		try {
			const result = await new Promise<{ stdout: string }>((resolve, reject) => {
				execFile(invocation.command, invocation.args, {
					env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
					shell: invocation.shell,
					windowsHide: true,
					timeout: 20_000,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				}, (error, stdout, stderr) => {
					if (error) {
						const message = (stderr || error.message).slice(0, 300);
						reject(new Error(message));
					} else {
						resolve({ stdout });
					}
				});
			});
			const models = parsePiListModels(result.stdout);
			if (models.length > 0 || args === argumentSets[argumentSets.length - 1]) return models;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw lastError ?? new Error("Unable to list Pi models");
}

/** Prefer RPC; retain the old CLI path as a compatibility fallback. */
async function runPiListModels(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
	const rpcModels = await runPiRpcModelList(piLocator, settingsStore).catch(() => []);
	if (rpcModels.length > 0) return rpcModels;
	return runPiTextModelList(piLocator, settingsStore);
}

function stopModelListProcess(child: ChildProcessWithoutNullStreams): void {
	if (!child.killed) child.kill();
}

/**
 * 获取模型列表（读缓存；无缓存时 fork 一次）。
 * 关键：空结果不写缓存——启动早期 pi 可能尚未就绪导致 fork 返回空，
 * 若把空数组缓存下来会永久显示「没有匹配的模型」。
 * 首次 fork 返回空时自动重试一次（间隔 500ms），覆盖 pi 冷启动慢的场景。
 * 返回的数组由调用方消费，不应修改。
 */
export function fetchModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
	if (cachedListModels) return Promise.resolve(cachedListModels);
	if (cachedListModelsPending) return cachedListModelsPending;

	cachedListModelsPending = runPiListModels(piLocator, settingsStore)
		.then(async (models) => {
			// 空结果重试一次：启动早期 pi 冷启动/环境未就绪时可能返回空表头。
			if (models.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				models = await runPiListModels(piLocator, settingsStore).catch(() => models);
			}
			// 仅非空结果入缓存；空结果（pi 未就绪/无可用模型）保持 null，下次重试。
			// 期间配置被保存过（configInvalidated）则丢弃本次结果，由 refresh 重取。
			if (models.length > 0 && !configInvalidated) cachedListModels = models;
			return models;
		})
		.finally(() => {
			cachedListModelsPending = null;
		});
	return cachedListModelsPending;
}

/**
 * 强制刷新模型列表（绕过缓存）：配置变更 / 启动 Agent 时调用。
 * 若存在在途请求（可能对应保存前的旧配置），不直接复用其结果——
 * 链式等它结束后重新 fork，保证返回的是新配置的列表。
 */
export function refreshModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
	const pending = cachedListModelsPending;
	if (pending) {
		// 旧请求结束后（其结果已被 invalidate 时的标记挡在缓存外）重新 fork；
		// 必须等旧 then 跑完再复位，否则旧结果会趁标记已清写进缓存。
		cachedListModelsPending = pending
			.catch(() => undefined)
			.then(() => {
				configInvalidated = false;
				return runPiListModels(piLocator, settingsStore);
			})
			.then(async (models) => {
				if (models.length === 0) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					models = await runPiListModels(piLocator, settingsStore).catch(() => models);
				}
				if (models.length > 0 && !configInvalidated) cachedListModels = models;
				return models;
			})
			.finally(() => {
				cachedListModelsPending = null;
			});
		return cachedListModelsPending;
	}
	// 无在途请求：立即复位，否则新 fork 结果会被 !configInvalidated 挡在缓存外。
	configInvalidated = false;
	cachedListModelsPending = runPiListModels(piLocator, settingsStore)
		.then(async (models) => {
			if (models.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				models = await runPiListModels(piLocator, settingsStore).catch(() => models);
			}
			if (models.length > 0 && !configInvalidated) cachedListModels = models;
			return models;
		})
		.finally(() => {
			cachedListModelsPending = null;
		});
	return cachedListModelsPending;
}

/** 清空模型列表缓存（配置变更后调用；后续 fetch 会重新 fork）。 */
export function invalidateModelListCache(): void {
	cachedListModels = null;
	// 在途请求让其自然完成；其结果不得写缓存（对应失效前配置），由 refreshModelList 重取。
	configInvalidated = true;
}

/** 获取当前缓存的模型列表（不触发新的 fork）。 */
export function getCachedModelList(): AvailableModel[] | null {
	return cachedListModels;
}
