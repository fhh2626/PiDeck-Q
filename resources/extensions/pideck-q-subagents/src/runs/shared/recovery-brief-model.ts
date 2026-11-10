/**
 * Bounded, tool-free inference for the subagent recovery brief.
 *
 * Design constraints (mirrors the watchdog review and the intent arbiter):
 *   - the child's OWN effective model and thinking level are used; there is no
 *     model switching and no fallback ladder,
 *   - one attempt with a hard timeout that aborts the agent, so a slow provider
 *     cannot leave an orphan promise behind the finished child,
 *   - no tools are offered and every tool call is blocked, so producing a brief
 *     can never mutate the workspace or the child session,
 *   - every failure returns `{ ok: false }`; the caller then emits the
 *     deterministic evidence brief.
 */

import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { agentStreamOptions } from "../../shared/agent-stream-options.ts";
import { THINKING_LEVELS, splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import {
	raceWithDeadline,
	type RecoveryBriefGenerator,
	type RecoveryBriefUsage,
} from "./recovery-brief.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
/** Extra grace for the aborted agent to unwind before the promise is settled. */
const ABORT_SETTLE_GRACE_MS = 3_000;
/** Bounded grace for a cancelled/timed-out inference to report spent usage. */
const ABORT_USAGE_GRACE_MS = 1_000;
/** Bounded so a runaway brief cannot grow the parent's context. */
const MAX_BRIEF_CHARS = 8_000;

type RegistryModel = NonNullable<ReturnType<NonNullable<ExtensionContext["modelRegistry"]["find"]>>>;

interface BriefAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}

export interface RecoveryBriefModelContext {
	model?: Pick<RegistryModel, "provider" | "id"> | undefined;
	modelRegistry: {
		find?: (provider: string, modelId: string) => RegistryModel | undefined;
		getAvailable?: () => Array<{ provider?: string; id?: string }>;
		getApiKeyAndHeaders?: (model: RegistryModel) => Promise<{
			ok: boolean;
			apiKey?: string;
			headers?: ProviderHeaders;
			env?: Record<string, string>;
			error?: string;
		}>;
		getRegisteredProviderConfig?: (provider: string) => { api?: string; streamSimple?: StreamFn } | undefined;
	};
}

/** Injectable transport so tests never touch a provider. */
export interface RecoveryBriefInferenceOutcome {
	text?: string;
	usage?: RecoveryBriefUsage;
	/** Failure reported by the transport (timeout, abort, provider error). */
	failure?: string;
}

export type RecoveryBriefInference = (input: {
	model: RegistryModel;
	thinkingLevel: ThinkingLevel;
	prompt: string;
	streamFn: StreamFn;
	signal?: AbortSignal;
	/** Remaining budget for this inference inside the whole summary deadline. */
	timeoutMs?: number;
}) => Promise<string | RecoveryBriefInferenceOutcome | undefined>;

/** Structural view of the pi Agent used by the default transport. */
export interface RecoveryBriefAgent {
	state: { messages: unknown };
	prompt(prompt: string): Promise<unknown>;
	abort(): void;
}

/** Constructor options shared by the real Agent and the test factory. */
export interface RecoveryBriefAgentOptions {
	initialState: {
		systemPrompt: string;
		model: RegistryModel;
		thinkingLevel: ThinkingLevel;
		tools: [];
	};
	streamFunction: StreamFn;
	streamFn: StreamFn;
	beforeToolCall: () => Promise<{ block: true; reason: string }>;
	toolExecution: "sequential";
}

/** Test seam replacing the dynamic pi Agent import; production never passes one. */
export type RecoveryBriefAgentFactory = (options: RecoveryBriefAgentOptions) => RecoveryBriefAgent;

export interface CreateRecoveryBriefGeneratorOptions {
	timeoutMs?: number;
	/** Test/config seam replacing the pi Agent transport. */
	inference?: RecoveryBriefInference;
	/** Test seam replacing the dynamic Agent module import. */
	agentFactory?: RecoveryBriefAgentFactory;
}

function splitProviderModel(value: string): { provider: string; id: string } | undefined {
	const slashIndex = value.indexOf("/");
	if (slashIndex <= 0 || slashIndex === value.length - 1) return undefined;
	return { provider: value.slice(0, slashIndex), id: value.slice(slashIndex + 1) };
}

/**
 * Resolve the child's effective model reference to a registry model.
 *
 * The child reports its model as `provider/id` (optionally with a `:thinking`
 * suffix) or a bare id. Only exact ids are accepted: the launch resolver's
 * fuzzy/date normalization could otherwise switch to a different model.
 * A bare id must identify exactly one provider.
 *
 * There is deliberately NO fallback to the parent session model or to "the only
 * available model": a brief attributed to the child has to be produced by the
 * child's own model. An unresolvable reference returns `undefined`, which makes
 * the caller emit the deterministic evidence brief.
 */
function resolveBriefModel(
	ctx: RecoveryBriefModelContext,
	modelRef: string | undefined,
): RegistryModel | undefined {
	if (!modelRef) return undefined;
	const registry = ctx.modelRegistry;
	const { baseModel } = splitKnownThinkingSuffix(modelRef);
	const named = splitProviderModel(baseModel);
	// Runtime snapshots are canonical provider/id references. A missing qualified
	// model must not be reinterpreted as another provider's bare model id.
	if (named) return registry.find?.(named.provider, named.id);
	const matches = (registry.getAvailable?.() ?? []).filter((entry) => entry.id === baseModel);
	if (matches.length !== 1 || !matches[0]?.provider || !matches[0].id) return undefined;
	return registry.find?.(matches[0].provider, matches[0].id);
}

function resolveThinkingLevel(thinking: string | undefined): ThinkingLevel {
	return THINKING_LEVELS.find((level) => level === thinking) ?? "off";
}

async function resolveBriefAuth(ctx: RecoveryBriefModelContext, model: RegistryModel): Promise<BriefAuth | undefined> {
	const registry = ctx.modelRegistry;
	if (!registry.getApiKeyAndHeaders) return {};
	try {
		// Call as a METHOD: the host registry implementation reads instance state.
		const auth = await registry.getApiKeyAndHeaders(model);
		if (auth.ok === false) return undefined;
		return {
			...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
			...(auth.headers ? { headers: auth.headers } : {}),
			...(auth.env ? { env: auth.env } : {}),
		};
	} catch {
		return undefined;
	}
}

function authWrappedStreamFn(base: StreamFn, auth: BriefAuth): StreamFn {
	return (model, context, streamOptions) => base(model, context, {
		...(streamOptions ?? {}),
		...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
		...(auth.env || streamOptions?.env ? { env: { ...(auth.env ?? {}), ...(streamOptions?.env ?? {}) } } : {}),
		headers: { ...(streamOptions?.headers ?? {}), ...(auth.headers ?? {}) },
	});
}

/** Prefer the provider's own registered stream; fall back to the shared simple stream. */
async function resolveBaseStreamFn(ctx: RecoveryBriefModelContext, model: RegistryModel): Promise<StreamFn> {
	const registered = ctx.modelRegistry.getRegisteredProviderConfig?.(model.provider);
	if (registered?.streamSimple && registered.api === model.api) return registered.streamSimple;
	const { streamSimple } = await import("@earendil-works/pi-ai/compat");
	return streamSimple;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Abort is a best-effort request; a transport that throws must not crash the timer. */
function requestAgentAbort(agent: RecoveryBriefAgent): void {
	try {
		agent.abort();
	} catch {
		// The inference is already failing; the deterministic brief is the fallback.
	}
}

/**
 * Sum provider-reported usage from the inference's assistant messages.
 *
 * The Agent may have produced a partial assistant message before a timeout or
 * cancellation; that reported usage is still real spend and must be preserved.
 */
function sumAssistantUsage(agent: RecoveryBriefAgent): RecoveryBriefUsage | undefined {
	const messages: unknown = agent.state.messages;
	if (!Array.isArray(messages)) return undefined;
	let usage: RecoveryBriefUsage | undefined;
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant") continue;
		const raw = message.usage;
		if (!isRecord(raw)) continue;
		const input = numberOrZero(raw.input);
		const output = numberOrZero(raw.output);
		const cacheRead = numberOrZero(raw.cacheRead);
		const cacheWrite = numberOrZero(raw.cacheWrite);
		const cost = typeof raw.cost === "number"
			? numberOrZero(raw.cost)
			: isRecord(raw.cost) ? numberOrZero(raw.cost.total) : 0;
		if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && cost === 0) continue;
		usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		usage.input += input;
		usage.output += output;
		usage.cacheRead += cacheRead;
		usage.cacheWrite += cacheWrite;
		usage.cost += cost;
	}
	return usage;
}

/** Agent.prompt may resolve with an error message instead of rejecting. */
function terminalAssistantFailure(agent: RecoveryBriefAgent): string | undefined {
	const messages: unknown = agent.state.messages;
	if (!Array.isArray(messages)) return undefined;
	const terminal = messages.findLast((message) => isRecord(message) && message.role === "assistant");
	if (!isRecord(terminal)) return undefined;
	if (terminal.stopReason !== "error" && terminal.stopReason !== "aborted" && terminal.stopReason !== "length") return undefined;
	return typeof terminal.errorMessage === "string" && terminal.errorMessage.trim()
		? terminal.errorMessage
		: `recovery-brief assistant ended with ${String(terminal.stopReason)}`;
}

function finalAssistantText(agent: RecoveryBriefAgent): string {
	const messages: unknown = agent.state.messages;
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) return "";
		const texts: string[] = [];
		for (const part of content) {
			if (!isRecord(part) || part.type !== "text") continue;
			const text = typeof part.text === "string" ? part.text : "";
			if (text.trim()) texts.push(text);
		}
		return texts.join("\n").trim();
	}
	return "";
}

/**
 * Default transport: one tool-free pi Agent turn against the resolved model.
 *
 * The timeout aborts the agent, and a hard settle deadline after the abort
 * guarantees this promise resolves even if the provider never unwinds — the
 * finished child must not leave a pending inference behind it. Usage reported
 * before a timeout/abort is returned with the failure.
 */
function createDefaultInference(timeoutMs: number, agentFactory?: RecoveryBriefAgentFactory): RecoveryBriefInference {
	return async ({ model, thinkingLevel, prompt, streamFn, signal, timeoutMs: requestedTimeoutMs }) => {
		// Never construct or prompt an agent after the caller already cancelled.
		if (signal?.aborted) return { text: "", failure: "recovery-brief inference aborted" };
		const effectiveTimeoutMs = Math.max(1, requestedTimeoutMs ?? timeoutMs);
		const agentOptions: RecoveryBriefAgentOptions = {
			initialState: {
				systemPrompt: "You summarize subagent execution evidence. You never execute work.",
				model,
				thinkingLevel,
				tools: [],
			},
			...agentStreamOptions(streamFn),
			beforeToolCall: async () => ({ block: true, reason: "Recovery brief generation is tool-free." }),
			toolExecution: "sequential",
		};
		let agent: RecoveryBriefAgent;
		if (agentFactory) {
			agent = agentFactory(agentOptions);
		} else {
			// Keep optional pi peers out of the static import graph.
			const [{ Agent }, { convertToLlm }] = await Promise.all([
				import("@earendil-works/pi-agent-core"),
				import("@earendil-works/pi-coding-agent"),
			]);
			if (signal?.aborted) return { text: "", failure: "recovery-brief inference aborted" };
			agent = new Agent({ ...agentOptions, convertToLlm });
		}
		// Dynamic module loading (or injected setup) can yield to cancellation.
		if (signal?.aborted) return { text: "", failure: "recovery-brief inference aborted" };

		let timedOut = false;
		let promptError: unknown;
		let hardSettle: ReturnType<typeof setTimeout> | undefined;
		const abortTimer = setTimeout(() => {
			timedOut = true;
			requestAgentAbort(agent);
		}, effectiveTimeoutMs);
		abortTimer.unref?.();
		const settleDeadline = new Promise<"deadline">((resolve) => {
			hardSettle = setTimeout(() => resolve("deadline"), effectiveTimeoutMs + ABORT_SETTLE_GRACE_MS);
			hardSettle.unref?.();
		});
		const onAbort = () => requestAgentAbort(agent);
		signal?.addEventListener("abort", onAbort, { once: true });
		let outcome: "settled" | "deadline";
		try {
			outcome = await Promise.race([
				agent.prompt(prompt).then(
					() => "settled" as const,
					(error) => {
						promptError = error;
						return "settled" as const;
					},
				),
				settleDeadline,
			]);
		} finally {
			clearTimeout(abortTimer);
			if (hardSettle) clearTimeout(hardSettle);
			signal?.removeEventListener("abort", onAbort);
		}
		const usage = sumAssistantUsage(agent);
		if (outcome === "deadline" || timedOut) {
			return {
				text: "",
				...(usage ? { usage } : {}),
				failure: `recovery-brief inference timed out after ${effectiveTimeoutMs}ms`,
			};
		}
		if (signal?.aborted) {
			return { text: "", ...(usage ? { usage } : {}), failure: "recovery-brief inference aborted" };
		}
		if (promptError) {
			return { text: "", ...(usage ? { usage } : {}), failure: errorMessage(promptError) };
		}
		const failure = terminalAssistantFailure(agent);
		if (failure) return { text: "", failure, ...(usage ? { usage } : {}) };
		return { text: finalAssistantText(agent), ...(usage ? { usage } : {}) };
	};
}

function normalizeInferenceOutcome(
	value: string | RecoveryBriefInferenceOutcome | undefined,
): { text: string; usage?: RecoveryBriefUsage; failure?: string } {
	if (typeof value === "string") return { text: value };
	if (!value) return { text: "" };
	return {
		text: typeof value.text === "string" ? value.text : "",
		...(value.usage ? { usage: value.usage } : {}),
		...(value.failure ? { failure: value.failure } : {}),
	};
}

/**
 * Build the generator handed to the runSync boundary.
 *
 * Always returns a generator: when no registry model can be resolved it reports
 * `model-unavailable`, which makes the caller emit the deterministic evidence
 * brief. That keeps the "brief always exists" promise in one place.
 *
 * `timeoutMs` bounds the WHOLE lifecycle: auth resolution, provider-stream
 * resolution, and the inference itself. A hanging auth lookup therefore degrades
 * to the deterministic brief instead of leaving the finished child pending.
 */
export function createRecoveryBriefGenerator(
	ctx: RecoveryBriefModelContext,
	options: CreateRecoveryBriefGeneratorOptions = {},
): RecoveryBriefGenerator {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const inference = options.inference ?? createDefaultInference(timeoutMs, options.agentFactory);

	return async (request) => {
		if (request.signal?.aborted) return { ok: false, reason: "aborted" };
		// No model reference means no child model to attribute the brief to; the
		// deterministic evidence brief is the honest answer.
		if (!request.model) return { ok: false, reason: "model-unavailable" };
		const model = resolveBriefModel(ctx, request.model);
		if (!model) return { ok: false, reason: "model-unavailable" };

		const deadline = Date.now() + timeoutMs;
		const remaining = () => Math.max(0, deadline - Date.now());
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		if (request.signal) {
			request.signal.addEventListener("abort", onAbort, { once: true });
			if (request.signal.aborted) {
				request.signal.removeEventListener("abort", onAbort);
				return { ok: false, reason: "aborted" };
			}
		}

		try {
			const authOutcome = await raceWithDeadline(resolveBriefAuth(ctx, model), remaining(), controller.signal);
			if (authOutcome.kind === "aborted") return { ok: false, reason: "aborted" };
			if (authOutcome.kind === "timeout") {
				controller.abort();
				return { ok: false, reason: `recovery-brief auth timed out after ${timeoutMs}ms` };
			}
			if (authOutcome.kind === "error") return { ok: false, reason: errorMessage(authOutcome.error) };
			if (!authOutcome.value) return { ok: false, reason: "model-auth-unavailable" };
			const auth = authOutcome.value;

			const streamOutcome = await raceWithDeadline(resolveBaseStreamFn(ctx, model), remaining(), controller.signal);
			if (streamOutcome.kind === "aborted") return { ok: false, reason: "aborted" };
			if (streamOutcome.kind === "timeout") {
				controller.abort();
				return { ok: false, reason: `recovery-brief stream resolution timed out after ${timeoutMs}ms` };
			}
			if (streamOutcome.kind === "error") return { ok: false, reason: errorMessage(streamOutcome.error) };
			if (remaining() <= 0) {
				controller.abort();
				return { ok: false, reason: `recovery-brief inference timed out after ${timeoutMs}ms` };
			}
			if (controller.signal.aborted) return { ok: false, reason: "aborted" };

			const streamFn = authWrappedStreamFn(streamOutcome.value, auth);
			const thinkingLevel = resolveThinkingLevel(request.thinking);
			const inferencePromise = inference({
				model,
				thinkingLevel,
				prompt: request.prompt,
				streamFn,
				timeoutMs: remaining(),
				signal: controller.signal,
			});
			const inferenceOutcome = await raceWithDeadline(
				inferencePromise,
				remaining(),
				controller.signal,
			);
			if (inferenceOutcome.kind === "aborted") {
				// The transport may have reported usage before it observed the abort;
				// preserve it, but never return a late brief.
				const late = await raceWithDeadline(inferencePromise, ABORT_USAGE_GRACE_MS);
				const usage = late.kind === "value" ? normalizeInferenceOutcome(late.value).usage : undefined;
				return { ok: false, reason: "aborted", ...(usage ? { usage } : {}) };
			}
			if (inferenceOutcome.kind === "timeout") {
				controller.abort();
				const late = await raceWithDeadline(inferencePromise, ABORT_USAGE_GRACE_MS);
				const usage = late.kind === "value" ? normalizeInferenceOutcome(late.value).usage : undefined;
				return {
					ok: false,
					reason: `recovery-brief inference timed out after ${timeoutMs}ms`,
					...(usage ? { usage } : {}),
				};
			}
			if (inferenceOutcome.kind === "error") return { ok: false, reason: errorMessage(inferenceOutcome.error) };

			const generated = normalizeInferenceOutcome(inferenceOutcome.value);
			if (generated.failure) {
				return {
					ok: false,
					reason: generated.failure,
					...(generated.usage ? { usage: generated.usage } : {}),
				};
			}
			const trimmed = generated.text.trim();
			if (!trimmed) {
				return {
					ok: false,
					reason: "empty-model-output",
					...(generated.usage ? { usage: generated.usage } : {}),
				};
			}
			return {
				ok: true,
				text: trimmed.length > MAX_BRIEF_CHARS ? `${trimmed.slice(0, MAX_BRIEF_CHARS)}\n… [brief truncated]` : trimmed,
				// Provenance of the text, so the brief never claims a model it did not use.
				model: `${model.provider}/${model.id}`,
				thinking: thinkingLevel,
				...(generated.usage ? { usage: generated.usage } : {}),
			};
		} catch (error) {
			return { ok: false, reason: errorMessage(error) };
		} finally {
			request.signal?.removeEventListener("abort", onAbort);
		}
	};
}
