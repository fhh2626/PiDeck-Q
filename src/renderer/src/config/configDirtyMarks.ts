import type { ConfigTab } from "./configTypes";

/** 脏标记 key：与 ConfigModal 的 sectionTabValue 编码一致（"config:<tab>" 或 section 名）。 */
export type ConfigDirtyKey = `config:${ConfigTab}` | "skills" | "prompts";

/**
 * loadConfig(target) 会把磁盘数据写回内存 state，被覆盖数据对应的「未保存修改」已不成立，
 * 必须同步清除脏标记，否则会出现：保存后黄点残留、关闭时误弹「未保存」确认（用户反馈的假脏标记）。
 * 规则：
 * - 目标 tab 自身必然重载；
 * - rawContent 在任何分支都会被重写（raw 编辑器内存内容随之丢失）；
 * - settings 聚合页还会顺带重载 models 的内存数据（同样被丢弃）。
 */
export function dirtyKeysClearedByReload(target: ConfigTab): ConfigDirtyKey[] {
	const keys = new Set<ConfigDirtyKey>([`config:${target}`, "config:raw"]);
	if (target === "settings") {
		keys.add("config:models");
	}
	return [...keys];
}

/** 配置导入会整体替换 models/settings 文件，需清掉全部 config 组脏标记（skills/prompts 编辑不涉及配置文件，保留）。 */
export const ALL_CONFIG_DIRTY_KEYS: readonly ConfigDirtyKey[] = [
	"config:models",
	"config:settings",
	"config:trust",
	"config:raw",
];
