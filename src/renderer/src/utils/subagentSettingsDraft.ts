/**
 * 子代理偏好弹框的草稿比较（纯函数，可单测）。
 *
 * 弹框同时编辑「全局」和「当前项目」两份配置，每份各留一份草稿：
 * - 切作用域不丢改动；
 * - 保存时把所有改动过的作用域一起写盘，不静默丢弃另一份。
 */

import type { SubagentSettings, SubagentSettingsScope } from "../../../shared/types";

/** 空草稿：两个开关都关，模型留空（用户打开开关后再选）。 */
export function emptySubagentSettingsDraft(): SubagentSettings {
	return { useOwnModel: false, preferDelegation: false };
}

/**
 * 两份偏好是否等价。
 * 关闭「独立模型」时保存会删除模型键，草稿里残留的模型选择不算改动。
 */
export function sameSubagentSettings(a: SubagentSettings, b: SubagentSettings): boolean {
	if (a.useOwnModel !== b.useOwnModel) return false;
	if (a.preferDelegation !== b.preferDelegation) return false;
	if (!a.useOwnModel) return true;
	return (a.model?.provider ?? "") === (b.model?.provider ?? "")
		&& (a.model?.modelId ?? "") === (b.model?.modelId ?? "")
		&& (a.model?.thinkingLevel ?? "") === (b.model?.thinkingLevel ?? "");
}

/** 有未保存改动的作用域；没有活动项目时项目作用域不参与。 */
export function dirtySubagentScopes(input: {
	drafts: Record<SubagentSettingsScope, SubagentSettings>;
	/** 已保存的值；项目作用域不可用时为 null。 */
	saved: { global: SubagentSettings; project: SubagentSettings | null };
	projectAvailable: boolean;
}): SubagentSettingsScope[] {
	const scopes: SubagentSettingsScope[] = ["global"];
	if (input.projectAvailable) scopes.push("project");
	return scopes.filter((scope) => {
		const saved = scope === "project" ? input.saved.project : input.saved.global;
		return !sameSubagentSettings(input.drafts[scope], saved ?? emptySubagentSettingsDraft());
	});
}
