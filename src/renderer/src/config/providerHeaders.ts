import { t, type TranslationKey } from "../i18n";

export function getUserAgentOptions() {
	return [
		{ value: "", label: t("config.userAgentRuntimeDefault") },
		{ value: "claude-cli/2.1.161 (external, cli)", label: "claude-cli/2.1.161 (external, cli)" },
		{ value: "claude-cli/2.1.161", label: "claude-cli/2.1.161" },
		{ value: "claude-code/1.0.0", label: "claude-code/1.0.0" },
		{ value: "claude-code/0.1.0", label: "claude-code/0.1.0" },
		{ value: "Kilo-Code/1.0", label: "Kilo-Code/1.0" },
		{ value: "OpenAI/JS 6.26.0", label: "OpenAI/JS 6.26.0" },
		{ value: "anthropic-sdk-typescript/0.27.3", label: "Anthropic SDK (anthropic-sdk-typescript/0.27.3)" },
		{ value: "Mozilla/5.0", label: t("config.userAgentBrowser") },
		{ value: "pi-coding-agent", label: "pi-coding-agent" },
		{ value: "python-requests/2.31.0", label: "Python Requests" },
		{ value: "axios/1.6.0", label: "Axios" },
	];
}
export const CUSTOM_USER_AGENT_VALUE = "__custom__";

export function getProviderHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(
		([key, headerValue]) =>
			key.trim().length > 0 && typeof headerValue === "string",
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function getHeaderValue(headers: unknown, targetKey: string) {
	const normalized = getProviderHeaders(headers);
	if (!normalized) return "";
	const entry = Object.entries(normalized).find(
		([key]) => key.toLowerCase() === targetKey.toLowerCase(),
	);
	return entry?.[1] ?? "";
}

export function setHeaderValue(
	headers: unknown,
	targetKey: string,
	value: string,
): Record<string, string> | undefined {
	const normalized = { ...(getProviderHeaders(headers) ?? {}) };
	for (const key of Object.keys(normalized)) {
		if (key.toLowerCase() === targetKey.toLowerCase()) delete normalized[key];
	}
	if (value.trim()) normalized[targetKey] = value.trim();
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

// pi provider 的 api 字段必须使用官方 registry 名称；openai-completions 实际对应 Chat Completions。
// 不再把历史别名 openai-chat-completions 作为预设暴露，避免测试通过但 pi 会话启动失败。
export const PROVIDER_API_OPTIONS = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
];

export const API_TYPE_LABELS: Record<string, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"openai-codex-responses": "OpenAI Codex Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Generative AI",
	"mistral-conversations": "Mistral Conversations",
};

const API_TYPE_DESCRIPTION_KEYS: Record<string, TranslationKey> = {
	"openai-completions": "config.apiTypeDescription.openaiCompletions",
	"openai-responses": "config.apiTypeDescription.openaiResponses",
	"openai-codex-responses": "config.apiTypeDescription.openaiCodexResponses",
	"anthropic-messages": "config.apiTypeDescription.anthropicMessages",
	"google-generative-ai": "config.apiTypeDescription.googleGenerativeAi",
	"mistral-conversations": "config.apiTypeDescription.mistralConversations",
};

export function getApiTypeDescription(apiType: string): string {
	const key = API_TYPE_DESCRIPTION_KEYS[apiType];
	return key ? t(key) : "";
}
