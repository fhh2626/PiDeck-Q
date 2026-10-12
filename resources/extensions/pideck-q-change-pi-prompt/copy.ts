/**
 * 扩展侧文案（中英双语）。
 *
 * 为什么单独放一个模块：扩展运行在 pi 子进程里，读不到 PiDeck 的渲染层 i18n；
 * 宿主通过 PIDECK_UI_LANGUAGE 环境变量把「生效界面语言」注入进来（同 PIDECK_SESSION_ID 模式），
 * 这里据此选择对应语言的用户可见提示。未注入时回退到系统语言，最后兜底中文。
 */

export type ExtensionLocale = 'zh-CN' | 'en-US';

/** 宿主注入的界面语言环境变量名；与 PiProcess 的 uiLocale 注入保持一致。 */
export const UI_LANGUAGE_ENV_NAME = 'PIDECK_UI_LANGUAGE';

/**
 * 解析界面语言。
 * 只认 en 开头的 BCP-47 标签为英文，其余（含空值）一律中文：
 * 项目历史文案以中文为主，未知语言回退中文比回退英文更贴近既有行为。
 */
export function resolveExtensionLocale(
	env: NodeJS.ProcessEnv = process.env,
	systemLocale?: string,
): ExtensionLocale {
	const raw = env?.[UI_LANGUAGE_ENV_NAME];
	const injected = typeof raw === 'string' ? raw.trim() : '';
	const candidate = injected || systemLocale?.trim() || '';
	if (!candidate) return 'zh-CN';
	return candidate.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

export interface ShellUnavailableCopy {
	/** 所有 shell 工具都被隐藏时的提示。 */
	allShellsHidden: string;
	/** rg/fd 后端缺失导致单个搜索工具被隐藏时的提示（{name} 为工具名）。 */
	searchHidden: (name: string) => string;
	/** 配置加载失败时的提示（{detail} 为错误摘要）。 */
	settingsLoadFailed: (detail: string) => string;
	/** 提示词改写失败时的提示（{detail} 为错误摘要）。 */
	rewriteFailed: (detail: string) => string;
	/** 上游工具指南在本会话内发生变化时的提示（{tool} 为工具名）。 */
	upstreamGuideChanged: (tool: string) => string;
}

const COPY_ZH_CN: ShellUnavailableCopy = {
	// 不分平台、不点名 bash：bash 不是必需品，只有真的一个 shell 都不剩时才提示。
	allShellsHidden: 'PowerShell 及其他 Shell 工具均不可用，已对本会话隐藏对应工具。',
	searchHidden: name => `${name} 的 rg/fd 后端不可用，已对本会话隐藏该工具。`,
	settingsLoadFailed: detail => `配置加载失败；保留上次有效配置或暂不改写提示词：${detail}`,
	rewriteFailed: detail => `改写失败，保留原提示词：${detail}`,
	upstreamGuideChanged: tool => `${tool} 的上游指南在本会话内发生变化；按当前来源规则处理，请检查替代文案。`,
};

const COPY_EN_US: ShellUnavailableCopy = {
	allShellsHidden: 'PowerShell and other shell tools are unavailable; the related tools are hidden for this session.',
	searchHidden: name => `${name} is unavailable because its rg/fd backend is missing; the tool is hidden for this session.`,
	settingsLoadFailed: detail => `Failed to load configuration; keeping the last valid configuration or leaving the prompt unchanged: ${detail}`,
	rewriteFailed: detail => `Prompt rewrite failed; keeping the original prompt: ${detail}`,
	upstreamGuideChanged: tool => `The upstream guide for ${tool} changed during this session; follow the current source rules and review the replacement copy.`,
};

export function shellUnavailableCopy(locale: ExtensionLocale): ShellUnavailableCopy {
	return locale === 'en-US' ? COPY_EN_US : COPY_ZH_CN;
}
