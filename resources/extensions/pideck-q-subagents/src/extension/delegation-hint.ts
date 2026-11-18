/**
 * 「优先委派」系统提示词增强。
 *
 * PiDeck 右侧「子代理」弹框把开关写入 pi settings.json 的
 * `subagents.preferDelegation`；扩展在 `before_agent_start` 里按该开关追加一句
 * 引导语，让主代理更倾向把复杂/可并行的任务交给子代理。
 *
 * 边界：
 * - 只作用于父会话。子代理进程带 `PI_SUBAGENT_CHILD`，注入会变成自我指涉的噪音。
 * - 只在 `subagent` 工具可用时注入：工具被裁掉时提示词让模型委派只会造成幻觉。
 * - 幂等：同一份 systemPrompt 重复经过本函数不会重复追加。
 */

import { resolveSubagentPreferDelegation } from "../agents/agents.ts";

/** 注入的引导语（英文，与 pi 的 system prompt 语言一致）。 */
export const DELEGATION_HINT =
	"Prefer delegating complex or parallelizable work to subagents; keep the main agent focused on planning, integration, and final verification.";

/** Keep this sentence identical to the independently installable change-pi-prompt extension. */
export const SUBAGENT_CALL_ANNOUNCEMENT_HINT =
	"Before each call to the subagent tool, first send the user one brief, visible assistant sentence in the conversation's language explaining what the call is about to do, then invoke the tool.";

/** 子代理进程的环境标记（与 runs/shared/child-runtime-config.ts 的常量同值）。 */
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

/** 纯函数：按开关把引导语追加为独立段落；已存在时不重复追加。 */
export function appendDelegationHint(systemPrompt: string, enabled: boolean): string {
	if (!enabled) return systemPrompt;
	if (systemPrompt.includes(DELEGATION_HINT)) return systemPrompt;
	return systemPrompt.trim() ? `${systemPrompt}\n\n${DELEGATION_HINT}` : DELEGATION_HINT;
}

/** Add the announcement rule independently of the optional delegation preference. */
export function appendSubagentCallAnnouncementHint(systemPrompt: string, enabled: boolean): string {
	if (!enabled || systemPrompt.includes(SUBAGENT_CALL_ANNOUNCEMENT_HINT)) return systemPrompt;
	return systemPrompt.trim()
		? `${systemPrompt}\n\n${SUBAGENT_CALL_ANNOUNCEMENT_HINT}`
		: SUBAGENT_CALL_ANNOUNCEMENT_HINT;
}

/** 当前进程是否是子代理（子代理不注入委派引导）。 */
export function isSubagentChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[SUBAGENT_CHILD_ENV];
	return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/** In-process children use a role marker instead of a process-wide environment variable. */
export function shouldInjectSubagentCallAnnouncementHint(input: {
	subagentToolAvailable: boolean;
	systemPrompt?: string;
	env?: NodeJS.ProcessEnv;
}): boolean {
	if (!input.subagentToolAvailable || isSubagentChildProcess(input.env)) return false;
	const prompt = input.systemPrompt ?? "";
	return !/<active_agent\s+name=["'][^"']+["']\s*\/?>/i.test(prompt)
		&& !prompt.includes("<!-- change-pi-prompt:child-tools:v1 -->");
}

/**
 * 解析本轮是否注入引导语：父会话 + 开关开启 + subagent 工具可用。
 * 读取配置失败按关闭处理（提示词增强不能阻断会话启动）。
 */
export function shouldInjectDelegationHint(input: {
	cwd: string;
	subagentToolAvailable: boolean;
	systemPrompt?: string;
	env?: NodeJS.ProcessEnv;
}): boolean {
	if (!shouldInjectSubagentCallAnnouncementHint(input)) return false;
	try {
		return resolveSubagentPreferDelegation(input.cwd);
	} catch {
		return false;
	}
}
