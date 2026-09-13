import { existsSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * PiDeck 内置扩展（随应用 resources 分发，不再复制到 ~/.pi/agent/extensions）。
 * 启动 RPC 时通过可重复的 `--extension/-e` 注入，避免污染用户全局 pi。
 */
export const BUILT_IN_EXTENSIONS = [
	"pideck-q-ask-question.ts",
	"pideck-q-context-controller.ts",
	"pi-deck-nul-redirect-fix.ts",
	"pi-deck-plan-mode.ts",
	"pi-deck-security-gate.ts",
	"pi-deck-todo.ts",
	"pi-deck-vision.ts",
	"pideck-q-websearch.ts",
	"pideck-q-better-compaction.ts",
	"pideck-q-change-pi-prompt.ts",
	"pideck-q-webfetch.ts",
	"pideck-q-subagents.ts",
] as const;

export type BuiltInExtensionName = (typeof BUILT_IN_EXTENSIONS)[number];

/** 出厂默认关闭的内置扩展；用户可在设置页恢复。 */
export const DEFAULT_DISABLED_BUILT_IN_EXTENSIONS = [
	"pideck-q-websearch.ts",
	"pideck-q-better-compaction.ts",
] as const satisfies readonly BuiltInExtensionName[];

/** 每次新增默认关闭的内置扩展时递增，用于老配置的一次性迁移。 */
export const BUILT_IN_EXTENSION_DEFAULTS_VERSION = 4;

/** 每个版本只登记当次新增的默认关闭项，避免升级时重新关闭用户已恢复的旧扩展。 */
const DEFAULT_DISABLED_MIGRATIONS: ReadonlyArray<{
	version: number;
	extensions: readonly BuiltInExtensionName[];
}> = [
	{ version: 1, extensions: ["pideck-q-better-compaction.ts"] },
	{ version: 2, extensions: ["pideck-q-websearch.ts"] },
	{ version: 3, extensions: [] },
	{ version: 4, extensions: [] },
];

/** 文件更名只迁移持久化身份，不改变用户此前的启用/禁用选择。 */
const BUILT_IN_EXTENSION_ALIASES: Readonly<Record<string, BuiltInExtensionName>> = {
	"pi-deck-ask-question.ts": "pideck-q-ask-question.ts",
	"pi-deck-context-controller.ts": "pideck-q-context-controller.ts",
	"pi-deck-websearch.ts": "pideck-q-websearch.ts",
	"pi-better-compaction.ts": "pideck-q-better-compaction.ts",
};

/** 升级后必须从 pi 自动发现目录清掉的旧入口，避免与重命名后的 -e 入口重复加载。 */
export const LEGACY_BUILT_IN_EXTENSION_NAMES = Object.freeze(
	Object.keys(BUILT_IN_EXTENSION_ALIASES),
);

export function migrateBuiltInExtensionDefaults(
	removedBuiltInExtensions: readonly string[] | undefined,
	persistedVersion: number | undefined,
): {
	removedBuiltInExtensions: string[];
	version: number;
	migrated: boolean;
} {
	const normalizedRemoved = (removedBuiltInExtensions ?? []).map(
		(name) => BUILT_IN_EXTENSION_ALIASES[name] ?? name,
	);
	const renamed = normalizedRemoved.some(
		(name, index) => name !== (removedBuiltInExtensions ?? [])[index],
	);
	if (persistedVersion === BUILT_IN_EXTENSION_DEFAULTS_VERSION && !renamed) {
		return {
			removedBuiltInExtensions: normalizedRemoved,
			version: persistedVersion,
			migrated: false,
		};
	}

	const next = new Set(normalizedRemoved);
	const previousVersion = persistedVersion ?? 0;
	for (const migration of DEFAULT_DISABLED_MIGRATIONS) {
		if (migration.version <= previousVersion) continue;
		for (const name of migration.extensions) next.add(name);
	}
	return {
		removedBuiltInExtensions: [...next],
		version: BUILT_IN_EXTENSION_DEFAULTS_VERSION,
		migrated: true,
	};
}

export type BuiltInExtensionPathRoots = {
	/** 开发态 app 根（含 resources/extensions） */
	appPath: string;
	/** 打包态 process.resourcesPath（extraResources 的 extensions/） */
	resourcesPath: string;
	isDev: boolean;
};

/** 校验 source 是否为允许的内置扩展 basename（防路径穿越）。 */
export function isBuiltInExtensionName(source: string): source is BuiltInExtensionName {
	const name = basename(source.trim());
	return (BUILT_IN_EXTENSIONS as readonly string[]).includes(name) && name === source.trim();
}

/**
 * 解析单个内置扩展在本机磁盘上的绝对路径。
 * 开发态读 appPath/resources/extensions；打包态读 resourcesPath/extensions。
 */
export function resolveBuiltInExtensionPath(
	extensionName: string,
	roots: BuiltInExtensionPathRoots,
): string {
	const name = basename(extensionName.trim());
	if (!isBuiltInExtensionName(name)) {
		throw new Error(`非法内置扩展名: ${extensionName}`);
	}
	return roots.isDev
		? join(roots.appPath, "resources", "extensions", name)
		: join(roots.resourcesPath, "extensions", name);
}

/**
 * 返回当前应注入到 pi RPC 的内置扩展绝对路径列表。
 * - removedBuiltInExtensions 中的跳过
 * - 源文件缺失的跳过（打日志由调用方处理）
 * - piRpcNoExtensions 由调用方决定是否整段跳过
 */
export function listActiveBuiltInExtensionPaths(
	roots: BuiltInExtensionPathRoots,
	removedBuiltInExtensions: readonly string[] = [],
): string[] {
	const removed = new Set(
		removedBuiltInExtensions.map((item) => basename(item.trim())).filter(Boolean),
	);
	const paths: string[] = [];
	for (const name of BUILT_IN_EXTENSIONS) {
		if (removed.has(name)) continue;
		const fullPath = resolveBuiltInExtensionPath(name, roots);
		if (!existsSync(fullPath)) continue;
		paths.push(fullPath);
	}
	return paths;
}

/**
 * 把内置扩展路径追加为可重复的 `--extension <path>`。
 * pi 文档：`--no-extensions` 只关自动发现，显式 -e 仍有效；
 * 但 PiDeck 约定 piRpcNoExtensions 时连内置也不注入（诊断干净）。
 */
export function appendBuiltInExtensionArgs(
	args: readonly string[],
	extensionPaths: readonly string[],
	options: { noExtensions?: boolean; noSkills?: boolean } = {},
): string[] {
	if (options.noExtensions || extensionPaths.length === 0) return [...args];
	const next = [...args];
	for (const extensionPath of extensionPaths) {
		const trimmed = extensionPath.trim();
		if (!trimmed) continue;
		next.push("--extension", trimmed);

		// 如果是 subagents 扩展，顺带挂载它自带的 package skills 和 prompt templates
		if (basename(trimmed) === "pideck-q-subagents.ts") {
			const pkgDir = join(trimmed, "..", "pideck-q-subagents");
			const skillsDir = join(pkgDir, "skills");
			const promptsDir = join(pkgDir, "prompts");
			if (!options.noSkills && existsSync(skillsDir)) {
				next.push("--skill", skillsDir);
			}
			if (existsSync(promptsDir)) {
				next.push("--prompt-template", promptsDir);
			}
		}
	}
	return next;
}
