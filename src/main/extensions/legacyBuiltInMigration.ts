/**
 * legacyBuiltInMigration (src/main/extensions/legacyBuiltInMigration.ts)
 *
 * 内置扩展的“旧全局入口”收编迁移。
 *
 * 背景：扩展在成为 PiDeck 内置资源之前，曾以用户全局扩展的形式写在
 * `<agentDir>/extensions/<name>.ts`。内置版经 `-e` 注入、全局版被 pi 自动发现，
 * 两份同时加载等于同一个扩展跑两个实例（重复的 system prompt 钩子与命令），
 * 所以启动时要处理旧文件。
 *
 * 硬性约束：**同名文件不保证是 PiDeck 生成的**。用户可能把某个 PiDeck 扩展复制到
 * 另一台机器继续自己改，也可能恰好用了同名文件；扩展目录下的 `.ts` 会被 pi 直接
 * 加载，删掉或搬走别人的文件 = 破坏用户源码。因此这里采用“正面识别才迁移，识别
 * 不了就原样保留”的白名单策略：
 *
 * - 文件不存在 / 读不到        → noop（读不到时绝不盲删）
 * - 内容命中 PiDeck 指纹       → 复制备份到 `<agentDir>/pideck-backups/<version>/`，回读校验后再删原件
 * - 内容未命中（未知来源）     → 原样保留 + warning
 * - 备份目录同名冲突           → 追加时间戳后缀，不覆盖既有备份
 * - 备份写不进 / 校验不一致    → 原件保留（宁可留双加载，不可丢文件）
 *
 * 备份目录刻意放在 extensions/ **之外**：pi 只自动发现
 * `~/.pi/agent/extensions/*.ts` 与该目录下的子目录入口（index.ts），
 * 放到兄弟目录才不会备份完又被自己加载回来。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 内容指纹：`all` 内的每条证据同时成立才认定该文件由 PiDeck 生成。 */
export interface LegacyEntryFingerprint {
	/** 规则名，仅用于日志定位命中的是哪条 */
	readonly label: string;
	readonly all: ReadonlyArray<(content: string) => boolean>;
}

export interface LegacyBuiltInEntryRule {
	/** 旧全局扩展文件名（含扩展名） */
	readonly fileName: string;
	/** 对应的内置扩展 id（仅用于日志/告警文案） */
	readonly builtInId: string;
	readonly fingerprints: readonly LegacyEntryFingerprint[];
}

/** 全部子串命中即成立的简写。 */
function has(...needles: string[]): (content: string) => boolean {
	return (content) => needles.every((needle) => content.includes(needle));
}

/**
 * PiDeck 确实写出过的旧全局入口形态。只列“结构上必然由我们生成”的组合：
 *
 * `self-use-shim`：迁入 PiDeck 源码前，本机自用版写下的转发入口。它同时引用
 * 同目录的 runtime 实现（`./change-pi-prompt/runtime.ts`）+ 固定的头部说明，
 * 两者均为我们写下的模板内容；用户自己写的 prompt 扩展不会拕带这条内置相对路径。
 *
 * 明确**不在**指纹内的：更早那份“自带完整实现的原始 change-pi-prompt.ts”
 * （含 os / spawnSync 平台探测）。它可能先于 PiDeck 存在于用户环境，归属不由
 * PiDeck 单方面判定，所以按“未知来源”保留在原地。
 */
const LEGACY_BUILT_IN_ENTRY_RULES: readonly LegacyBuiltInEntryRule[] = [
	{
		fileName: "change-pi-prompt.ts",
		builtInId: "pideck-q-change-pi-prompt",
		fingerprints: [
			{
				label: "self-use-shim",
				all: [
					has("registerPromptExtension", "./change-pi-prompt/runtime.ts"),
					has("Pi prompt replacement extension"),
				],
			},
		],
	},
];

export function getLegacyBuiltInEntryRules(): readonly LegacyBuiltInEntryRule[] {
	return LEGACY_BUILT_IN_ENTRY_RULES;
}

/**
 * 正面识别：返回命中的指纹 label，未命中（含规则里没这个文件名）返回 null。
 * 判定纯函数化，便于单测覆盖每条指纹的正反例。
 */
export function identifyLegacyBuiltInEntry(
	fileName: string,
	content: string,
): string | null {
	const rule = LEGACY_BUILT_IN_ENTRY_RULES.find((entry) => entry.fileName === fileName);
	if (!rule) return null;
	for (const fingerprint of rule.fingerprints) {
		if (fingerprint.all.every((predicate) => predicate(content))) {
			return fingerprint.label;
		}
	}
	return null;
}

/** 去掉扩展名（只切最后一个点，且忽略前导点文件）。 */
function stemOf(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * 备份目标名：同名已占用时追加时间戳后缀。备份目录跨版本、跨次运行复用，
 * 同名文件承载的是不同时期的内容，覆盖即丢历史。
 */
export function resolveBackupFileName(used: (name: string) => boolean, fileName: string, timestamp = Date.now()): string {
	let candidate = fileName;
	let attempt = 0;
	while (used(candidate)) {
		attempt += 1;
		const suffix = attempt === 1 ? String(timestamp) : `${timestamp}-${attempt}`;
		candidate = `${stemOf(fileName)}.${suffix}.ts`;
	}
	return candidate;
}

export interface LegacyBuiltInMigrationOutcome {
	/** 已备份并移除的旧入口 */
	moved: Array<{ fileName: string; fingerprint: string; backup: string }>;
	/** 未识别或备份失败、原样保留的旧入口 */
	preserved: Array<{ fileName: string; path: string; reason: "unknown" | "backup-failed" }>;
	/** 需要落到日志的用户可见问题（保留原因等） */
	warnings: string[];
}

async function exists(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * 迁移单个 agent 目录（Windows 本机或 WSL 的 UNC 映射目录）。
 * 目录内每个受管文件名独立处理；任何一步失败都只记 warning，不抛出中断启动。
 */
async function migrateOneAgentDir(
	agentDir: string,
	version: string,
	outcome: LegacyBuiltInMigrationOutcome,
): Promise<void> {
	const extensionsDir = join(agentDir, "extensions");
	const backupDir = join(agentDir, "pideck-backups", version);

	for (const rule of LEGACY_BUILT_IN_ENTRY_RULES) {
		const source = join(extensionsDir, rule.fileName);
		if (!(await exists(source))) continue;

		let content: string;
		try {
			content = await readFile(source, "utf8");
		} catch (error) {
			// EACCES / EISDIR 等：读不到内容就无法判定归属，按“未知”保留。
			const message = error instanceof Error ? error.message : String(error);
			outcome.preserved.push({ fileName: rule.fileName, path: source, reason: "unknown" });
			outcome.warnings.push(`Cannot read ${source} (${message}); left in place.`);
			continue;
		}

		const fingerprint = identifyLegacyBuiltInEntry(rule.fileName, content);
		if (!fingerprint) {
			// 未知来源：保留用户文件。代价是内置版与全局版会同时加载，
			// 因此必须把处置方式写进日志，让用户能自行改名/删除。
			outcome.preserved.push({ fileName: rule.fileName, path: source, reason: "unknown" });
			outcome.warnings.push(
				`${source} is not a PiDeck-authored file; kept in place. Built-in "${rule.builtInId}" and this global copy will both load — rename or remove the file to use the built-in alone.`,
			);
			continue;
		}

		try {
			await mkdir(backupDir, { recursive: true });
			// 冲突处理以磁盘事实为准（备份目录跨版本复用，内存里没有历史名单）；
			// 写入仍用 flag:"wx" 拾回并发/重复运行下“探测完刚好被别人占用”的竞态。
			const backupName = resolveBackupFileName((name) => existsSync(join(backupDir, name)), rule.fileName);
			const backup = join(backupDir, backupName);
			// 写副本 → 回读校验一致 → 才删原件。“已验证备份存在”是删原件的前置条件。
			await writeFile(backup, content, { encoding: "utf8", flag: "wx" });
			if ((await readFile(backup, "utf8")) !== content) {
				throw new Error(`backup content mismatch: ${backup}`);
			}
			await rm(source);
			outcome.moved.push({ fileName: rule.fileName, fingerprint, backup });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outcome.preserved.push({ fileName: rule.fileName, path: source, reason: "backup-failed" });
			outcome.warnings.push(`Cannot back up ${source} (${message}); left in place.`);
		}
	}
}

/**
 * 启动期迁移入口。`agentDirs` 由调用方给出（本机 + 已启用的 WSL agent 目录），
 * 每个目录独立处理，一个失败不影响其余。
 */
export async function migrateLegacyBuiltInEntries(
	agentDirs: readonly string[],
	version: string,
): Promise<LegacyBuiltInMigrationOutcome> {
	const outcome: LegacyBuiltInMigrationOutcome = { moved: [], preserved: [], warnings: [] };
	for (const dir of agentDirs) {
		await migrateOneAgentDir(dir, version, outcome);
	}
	return outcome;
}
