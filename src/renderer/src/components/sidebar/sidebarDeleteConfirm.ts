import type { I18nParams, SessionRecord, SessionSummary } from "../../../../shared/types";
import type { TranslationKey } from "../../i18n";

export type SessionDeleteConfirmConfig = {
	title: string;
	message: string;
	danger: boolean;
	confirmLabel: string;
	onConfirm: () => void;
};

/**
 * 构造普通/历史会话删除的确认弹窗配置（子会话感知）。
 * 生产代码 App.tsx 实际调用，单测可直接对本纯函数断言。
 */
export function buildSidebarSessionDeleteConfirm(input: {
	session: Pick<SessionSummary, "name" | "filePath">;
	childCount: number;
	t: (key: TranslationKey, params?: I18nParams) => string;
	onExecuteDelete: () => void;
	clearConfirm: () => void;
}): SessionDeleteConfirmConfig {
	const message =
		input.childCount > 0
			? input.t("drawer.sessionDeleteBodyWithChildren", {
					name: input.session.name || input.t("common.untitled"),
					count: input.childCount,
				})
			: input.t("drawer.sessionDeleteBody", {
					name: input.session.name || input.t("common.untitled"),
				});
	return {
		title: input.t("drawer.sessionDeleteTitle"),
		message,
		danger: true,
		confirmLabel: input.t("common.delete"),
		onConfirm: () => {
			input.clearConfirm();
			input.onExecuteDelete();
		},
	};
}

/**
 * 构造草稿会话删除的确认弹窗配置。
 */
export function buildDraftSessionDeleteConfirm(input: {
	session: Pick<SessionRecord, "title">;
	t: (key: TranslationKey, params?: I18nParams) => string;
	onExecuteDelete: () => void;
	clearConfirm: () => void;
}): SessionDeleteConfirmConfig {
	return {
		title: input.t("drawer.sessionDeleteTitle"),
		message: input.t("drawer.sessionDeleteBody", {
			name: input.session.title || input.t("common.untitled"),
		}),
		danger: true,
		confirmLabel: input.t("common.delete"),
		onConfirm: () => {
			input.clearConfirm();
			input.onExecuteDelete();
		},
	};
}
