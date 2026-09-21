/**
 * SecurityStore（src/main/security/SecurityStore.ts）
 *
 * 安全管理配置的唯一 owner：
 * - 配置持久化在 AppSettings.securityConfig（settings.json，经 SettingsStore 保存）；
 * - 每次配置/会话等级变更后，把「策略快照」写入 userData/security-policy.json，
 *   pi-deck-security-gate 扩展按快照执行拦截（无 IPC 依赖，运行时随时重读）。
 *
 * 会话级覆盖的键 = 稳定的 SessionRecord.id（UUID），不是文件路径或运行时 agentId；
 * 快照 key 用同样的键，扩展通过 PIDECK_SESSION_ID 环境变量拿当前会话身份。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { renameWithRetry } from "../utils/fsRetry";
import {
	createDefaultSecurityConfig,
	type SecurityConfig,
	type SecurityPolicySnapshot,
} from "../../shared/types/security";
import type { SettingsStore } from "../settings/SettingsStore";
import { buildSnapshot, validateSecurityConfig } from "./policy";

/** 快照文件名：扩展经 PIDECK_SECURITY_CONFIG 环境变量读取 */
export const SNAPSHOT_FILE = "security-policy.json";

export const SECURITY_SNAPSHOT_WRITE_FAILED = "SECURITY_SNAPSHOT_WRITE_FAILED";
export const SECURITY_CONFIG_VALIDATION_FAILED = "SECURITY_CONFIG_VALIDATION_FAILED";

export class SecurityConfigValidationError extends Error {
	readonly code = SECURITY_CONFIG_VALIDATION_FAILED;
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SecurityConfigValidationError";
	}
}

export class SecuritySnapshotWriteError extends Error {
	readonly code = SECURITY_SNAPSHOT_WRITE_FAILED;
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SecuritySnapshotWriteError";
	}
}

/** 由 SettingsStore 提供配置读写（依赖注入，便于测试与替换） */
export type SecurityStoreDeps = {
	settingsStore: SettingsStore;
	userDataDir?: string;
	/** 日志回调（与 appLogger.info 同签名；不强制，缺省静默） */
	log?: (domain: string, message: string, details?: Record<string, unknown>) => void;
};

export class SecurityStore {
	private readonly settingsStore: SettingsStore;
	private readonly userDataDir: string;
	private readonly log: (domain: string, message: string, details?: Record<string, unknown>) => void;
	private queueTail: Promise<unknown> = Promise.resolve();

	constructor(deps: SecurityStoreDeps) {
		this.settingsStore = deps.settingsStore;
		this.userDataDir = deps.userDataDir ?? join(homedir(), ".pi-desktop");
		this.log = deps.log ?? (() => undefined);
	}

	/** 快照绝对路径（Windows 用户数据目录；WSL 下由 PiProcess 转 Linux路径后注入） */
	getSnapshotPath(): string {
		return join(this.userDataDir, SNAPSHOT_FILE);
	}

	/**
	 * 读取配置并做向后兼容归一化：
	 * - 字段缺失时并入默认值（旧版本设置文件没有 securityConfig 字段）；
	 * - 保证内置等级存在（id 固定，用户编辑过的内置等级保留其内容）；
	 * - defaultLevelId 指向不存在的等级时回退 standard。
	 */
	getConfig(): SecurityConfig {
		const raw = this.settingsStore.get().securityConfig;
		return this.normalizeConfig(raw);
	}

	/** 归一化（见 getConfig 注释）；纯函数便于单测。 */
	normalizeConfig(raw: SecurityConfig | undefined): SecurityConfig {
		const def = createDefaultSecurityConfig();
		if (!raw || typeof raw !== "object") return def;

		const mergedLevels = [...def.levels];
		if (Array.isArray(raw.levels)) {
			for (const level of raw.levels) {
				if (!level || typeof level.id !== "string") continue;
				const idx = mergedLevels.findIndex((m) => m.id === level.id);
				if (idx >= 0) mergedLevels[idx] = level;
				else mergedLevels.push(level);
			}
		}

		const hasDefault = mergedLevels.some((level) => level.id === raw.defaultLevelId);
		return {
			enabled: raw.enabled === true,
			defaultLevelId: hasDefault ? raw.defaultLevelId : def.defaultLevelId,
			levels: mergedLevels,
			sessionOverrides:
				raw.sessionOverrides && typeof raw.sessionOverrides === "object"
					? { ...raw.sessionOverrides }
					: {},
		};
	}

	/**
	 * 更新配置（校验 + 持久化 + 刷新快照）。
	 * 校验失败时抛错，IPC 层转结构化错误返回。
	 * settings 先持久化，快照后发布：写快照失败表示未确认生效，不回滚设置；
	 * getConfig 可读到新设置，后续成功更新或启动屏障会重新发布它。
	 */
	updateConfig(patch: Partial<SecurityConfig>): Promise<SecurityConfig> {
		return this.enqueue(async () => {
			const current = this.getConfig();

			// 检查 patch 中明确提供的新字段合法性（不盲目静默丢弃）
			const next: SecurityConfig = {
				...current,
				...patch,
				levels: patch.levels ?? current.levels,
			};

			// 先验证等级结构，再读取 id。仅删除从旧配置继承、且本次确实删除了等级的覆盖；
			// 显式提交的覆盖必须完整校验，不能静默丢弃后回退到较宽松的默认等级。
			if (patch.levels && !Object.hasOwn(patch, "sessionOverrides")) {
				const levelErrors = validateSecurityConfig({ ...next, sessionOverrides: {} });
				if (levelErrors.length > 0) {
					throw new SecurityConfigValidationError(`安全配置校验失败: ${levelErrors.join("; ")}`);
				}
				const activeIds = new Set(next.levels.map((level) => level.id));
				const removedIds = new Set(current.levels.filter((level) => !activeIds.has(level.id)).map((level) => level.id));
				next.sessionOverrides = Object.fromEntries(
					Object.entries(next.sessionOverrides).filter(([, levelId]) => !removedIds.has(levelId)),
				);
			}

			const errors = validateSecurityConfig(next);
			if (errors.length > 0) {
				throw new SecurityConfigValidationError(`安全配置校验失败: ${errors.join("; ")}`);
			}

			const normalized = this.normalizeConfig(next);
			await this.settingsStore.update({ securityConfig: normalized });
			await this.writeSnapshot(normalized);
			this.log("security", "Security config updated", {
				enabled: normalized.enabled,
				defaultLevelId: normalized.defaultLevelId,
				levels: normalized.levels.length,
			});
			return normalized;
		});
	}

	/** 设置会话级覆盖：levelId 为空/null = 清除覆盖（跟随全局默认）。若请求了非空等级但该等级不存在，抛出校验错误。 */
	setSessionLevel(sessionId: string, levelId: string | null): Promise<SecurityConfig> {
		return this.enqueue(async () => {
			const current = this.getConfig();
			const sessionOverrides = { ...current.sessionOverrides };
			const prev = sessionOverrides[sessionId] ?? null;

			if (levelId === null || levelId === undefined || levelId === "") {
				// 明确请求清除覆盖
				delete sessionOverrides[sessionId];
			} else {
				// 检查最新等级表中是否存在该等级
				const exists = current.levels.some((level) => level.id === levelId);
				if (!exists) {
					throw new SecurityConfigValidationError(`安全等级不存在: ${levelId}`);
				}
				sessionOverrides[sessionId] = levelId;
			}

			if (prev !== (sessionOverrides[sessionId] ?? null)) {
				this.log("security", "Session security level changed", {
					sessionId,
					from: prev,
					to: sessionOverrides[sessionId] ?? null,
				});
			}
			const next: SecurityConfig = {
				...current,
				sessionOverrides,
			};
			const errors = validateSecurityConfig(next);
			if (errors.length > 0) {
				throw new SecurityConfigValidationError(`安全配置校验失败: ${errors.join("; ")}`);
			}
			const normalized = this.normalizeConfig(next);
			await this.settingsStore.update({ securityConfig: normalized });
			await this.writeSnapshot(normalized);
			return normalized;
		});
	}

	/** 查询会话当前生效等级 id（覆盖优先，否则全局默认）。 */
	getSessionLevelId(sessionId: string | undefined): string {
		const config = this.getConfig();
		const override = sessionId ? config.sessionOverrides[sessionId] : undefined;
		return override ?? config.defaultLevelId;
	}

	/** 确保快照已写入（Agent 启动前调用；排入统一队列）。 */
	ensureSnapshotWritten(): Promise<void> {
		return this.enqueue(async () => {
			await this.writeSnapshot(this.getConfig());
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queueTail.then(task, task);
		this.queueTail = next.then(() => undefined, () => undefined);
		return next;
	}

	/** 写快照文件（原子写：先写临时文件再 rename，避免扩展读到半截 JSON）。 */
	private async writeSnapshot(config: SecurityConfig): Promise<void> {
		const snapshot: SecurityPolicySnapshot = buildSnapshot(config);
		const target = this.getSnapshotPath();
		const tmp = `${target}.tmp`;
		try {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
			// 杀软扫描可能瞬时锁住刚写出的 tmp，rename 走退避重试
			await renameWithRetry(tmp, target);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.log("security", "Snapshot write failed", { error: msg });
			throw new SecuritySnapshotWriteError(`Failed to write security policy snapshot: ${msg}`, { cause: error });
		}
	}
}
