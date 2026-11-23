/**
 * Recovery brief lifecycle: decide, generate, degrade, format.
 *
 * Scope (deliberately narrow):
 *   - only a FINAL abnormal termination of a child that actually executed,
 *   - one bounded, tool-free inference using the child's own model/thinking,
 *   - a deterministic evidence brief whenever that inference cannot run,
 *   - never mutate the child's original failure, output, or acceptance state.
 *
 * No periodic monitoring and no automatic restart live here: the brief only
 * tells the parent what happened and how to continue the same child session.
 */

import { buildRecoveryBriefPrompt } from "./recovery-brief-prompt.ts";
import {
	buildRecoveryBriefEvidence,
	type RecoveryBriefEvidence,
	type RecoveryBriefEvidenceInput,
	type RecoveryBriefMessage,
	type RecoveryBriefRecentTool,
} from "./recovery-brief-evidence.ts";

/**
 * Token/cost usage reported by the brief inference.
 *
 * Deliberately excludes `turns`: the inference is not a child execution turn,
 * so folding it into the child's usage must not inflate turn counts.
 */
export interface RecoveryBriefUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface RecoveryBrief {
	/** Markdown brief produced by the model, or the deterministic fallback. */
	text: string;
	source: "model" | "fallback";
	/**
	 * Model the text was produced with: the model the inference actually ran on
	 * for `source: "model"`, or the child's effective model for the deterministic
	 * fallback (where nothing was inferred).
	 */
	model?: string;
	/** Thinking level that accompanied {@link model}, when known. */
	thinking?: string;
	/** Why the deterministic fallback was used instead of the model. */
	reason?: string;
	/**
	 * Measured inference usage, kept here as evidence. The caller folds this into
	 * the child's accounting exactly once via {@link foldRecoveryBriefUsage}.
	 */
	usage?: RecoveryBriefUsage;
}

export interface RecoveryBriefTriggerInput {
	exitCode: number;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	interrupted?: boolean;
	detached?: boolean;
	/** Parent cancellation/shutdown: no inference may start. */
	aborted?: boolean;
	messageCount: number;
	toolCount: number;
	turns: number;
}

/**
 * A brief is worth generating only when the child ended abnormally AFTER doing
 * real work. Success, explicit stop/interrupt, a still-live detach receipt,
 * parent cancellation, and prelaunch failures all stay silent.
 */
export function shouldGenerateRecoveryBrief(input: RecoveryBriefTriggerInput): boolean {
	if (input.aborted) return false;
	if (input.stopped || input.interrupted) return false;
	if (input.detached) return false;
	const abnormal = input.exitCode !== 0 || Boolean(input.error) || input.timedOut === true;
	if (!abnormal) return false;
	return input.messageCount > 0 || input.toolCount > 0 || input.turns > 0;
}

/** Structural view of the result the brief is derived from. */
export interface RecoveryBriefResultLike {
	exitCode: number;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	interrupted?: boolean;
	detached?: boolean;
	model?: string;
	thinking?: string;
	messages?: readonly RecoveryBriefMessage[];
	usage?: { turns?: number };
	progressSummary?: { toolCount?: number; tokens?: number; durationMs?: number };
}

/** Structural view of the extra result fields that only feed the evidence. */
export interface RecoveryBriefSourceResult extends RecoveryBriefResultLike {
	task: string;
	agent?: string;
	progress?: { recentTools?: readonly RecoveryBriefRecentTool[] };
	attemptedModels?: readonly string[];
	sessionFile?: string;
	transcriptPath?: string;
	artifactPaths?: { outputPath?: string; metadataPath?: string; transcriptPath?: string };
}

export interface RecoveryBriefGenerationRequest {
	/** Effective child model reference (may carry a thinking suffix). */
	model?: string;
	thinking?: string;
	prompt: string;
	signal?: AbortSignal;
}

export type RecoveryBriefGenerationOutcome =
	| {
		ok: true;
		text: string;
		/** Model/provider the inference actually ran on. */
		model?: string;
		/** Thinking level the inference actually ran with. */
		thinking?: string;
		/** Usage the provider reported for the inference. */
		usage?: RecoveryBriefUsage;
	}
	| {
		ok: false;
		reason: string;
		/** Usage reported before a failure/timeout/cancel, when available. */
		usage?: RecoveryBriefUsage;
	};

export type RecoveryBriefGenerator = (
	request: RecoveryBriefGenerationRequest,
) => Promise<RecoveryBriefGenerationOutcome>;

export interface ApplyRecoveryBriefInput {
	result: RecoveryBriefResultLike;
	/**
	 * Raw evidence source. Rendered only after the trigger check passes, so a
	 * successful child never pays for the timeline flatten and phase render.
	 */
	evidenceInput: RecoveryBriefEvidenceInput;
	generator?: RecoveryBriefGenerator;
	/** A usage budget governs this run: spend nothing extra and use the fallback. */
	inferenceBudgetConfigured?: boolean;
	aborted?: boolean;
	/** The run detached after publishing a receipt; the authoritative completion must stay silent. */
	detached?: boolean;
	signal?: AbortSignal;
	/** Hard bound for the whole summary lifecycle, including auth resolution. */
	deadlineMs?: number;
}

/** Runtime identity and the context present before this execution started. */
export interface RecoveryBriefRuntimeSnapshot {
	model?: string;
	thinking?: string;
	priorMessages?: readonly RecoveryBriefMessage[];
}

/** Prefer the last actual request's identity over launch aliases or defaults. */
export function captureRecoveryBriefIdentity(
	session: { readonly modelId?: string; readonly thinkingLevel?: string },
	messages: readonly RecoveryBriefMessage[] = [],
): RecoveryBriefRuntimeSnapshot {
	const terminal = messages.findLast((message) => message.role === "assistant");
	const raw = terminal && typeof terminal === "object" ? terminal : undefined;
	const model = typeof raw?.provider === "string" && typeof raw.model === "string"
		? `${raw.provider}/${raw.model}` : session.modelId;
	const thinking = typeof raw?.thinkingLevel === "string" ? raw.thinkingLevel : session.thinkingLevel;
	return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

/** Run-level inputs the brief request is assembled from. */
export interface RecoveryBriefRunOptions {
	generator?: RecoveryBriefGenerator;
	/** Ordered per-attempt messages, preserving work completed before a retry. */
	attemptMessages?: readonly (readonly RecoveryBriefMessage[])[];
	/** Actual child identity, plus stored history when continuing a session. */
	runtime?: RecoveryBriefRuntimeSnapshot;
	/** A usage budget governs this run: extra spend is not authorized. */
	usageBudgetConfigured?: boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
	/** The run detached after publishing a receipt; suppress the brief. */
	detached?: boolean;
}

/**
 * Map a finished child result onto the brief request.
 *
 * Exported and pure so the wiring itself is testable: a wrong field name here
 * would silently drop evidence (or the budget/cancel guard) while every other
 * test still passed.
 */
export function recoveryBriefRequest(
	result: RecoveryBriefSourceResult,
	options: RecoveryBriefRunOptions = {},
): ApplyRecoveryBriefInput {
	// This diagnostic view leaves the primary task's launch/result fields intact.
	const effectiveResult = options.runtime ? {
		...result,
		...(options.runtime.model ? { model: options.runtime.model } : {}),
		...(options.runtime.thinking ? { thinking: options.runtime.thinking } : {}),
	} : result;
	// Keep earlier work available to the summary without changing task output or
	// paying to flatten all attempts for successful/cancelled/detached runs.
	const messages = options.attemptMessages && options.attemptMessages.length > 1
		&& shouldGenerateRecoveryBrief(triggerInputFor(result, options.signal?.aborted === true, options.detached === true))
		? options.attemptMessages.flat()
		: result.messages;
	return {
		result: effectiveResult,
		evidenceInput: {
			task: result.task,
			exitCode: result.exitCode,
			...(result.agent ? { agent: result.agent } : {}),
			...(result.error ? { error: result.error } : {}),
			...(result.timedOut ? { timedOut: true } : {}),
			...(effectiveResult.model ? { model: effectiveResult.model } : {}),
			...(effectiveResult.thinking ? { thinking: effectiveResult.thinking } : {}),
			...(messages ? { messages } : {}),
			...(options.runtime?.priorMessages ? { priorMessages: options.runtime.priorMessages } : {}),
			...(result.progress?.recentTools ? { recentTools: result.progress.recentTools } : {}),
			...(result.progressSummary ? { progressSummary: result.progressSummary } : {}),
			...(result.attemptedModels ? { attemptedModels: result.attemptedModels } : {}),
			...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
			...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
			...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
		},
		...(options.generator ? { generator: options.generator } : {}),
		...(options.usageBudgetConfigured ? { inferenceBudgetConfigured: true } : {}),
		...(options.signal?.aborted ? { aborted: true } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
		...(options.detached ? { detached: true } : {}),
	};
}

function triggerInputFor(result: RecoveryBriefResultLike, aborted: boolean, detached: boolean): RecoveryBriefTriggerInput {
	return {
		exitCode: result.exitCode,
		...(result.error ? { error: result.error } : {}),
		...(result.timedOut ? { timedOut: true } : {}),
		...(result.stopped ? { stopped: true } : {}),
		...(result.interrupted ? { interrupted: true } : {}),
		...(result.detached || detached ? { detached: true } : {}),
		...(aborted ? { aborted: true } : {}),
		messageCount: Array.isArray(result.messages) ? result.messages.length : 0,
		toolCount: result.progressSummary?.toolCount ?? 0,
		turns: result.usage?.turns ?? 0,
	};
}

/**
 * Deterministic brief built only from recorded evidence.
 * Used whenever the model cannot run (budget, no generator, auth/model error,
 * timeout, empty output) so the parent still gets a usable recovery summary.
 */
export function deterministicRecoveryBrief(evidence: RecoveryBriefEvidence): string {
	const sections = [
		"## Subagent Recovery Brief",
		`### Original objective\n${evidence.originalTask}`,
		`### Termination\n${evidence.terminationInfo}`,
		`### Recent tool activity\n${evidence.recentToolCalls}`,
		`### Execution record (phase coverage)\n${evidence.executionHistory}`,
		`### References\n${evidence.recoveryReferences}`,
	];
	if (evidence.truncated) {
		sections.push("Note: parts of the execution record were clipped or omitted; treat unlisted work as unconfirmed.");
	}
	return sections.join("\n\n");
}

/** Hard bound for the whole summary lifecycle (auth + provider stream + inference). */
export const RECOVERY_BRIEF_DEADLINE_MS = 25_000;
/** Bounded grace for a cancelled generator to report already-spent usage. */
const RECOVERY_BRIEF_ABORT_USAGE_GRACE_MS = 1_000;

export type DeadlineOutcome<T> =
	| { kind: "value"; value: T }
	| { kind: "error"; error: unknown }
	| { kind: "timeout" }
	| { kind: "aborted" };

/**
 * Race a promise against a hard deadline and an optional abort signal.
 *
 * The promise always gets a rejection handler, so a late failure after the
 * deadline/abort is never an unhandled rejection.
 */
export function raceWithDeadline<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<DeadlineOutcome<T>> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (outcome: DeadlineOutcome<T>) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = () => finish({ kind: "aborted" });
		timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, timeoutMs));
		timer.unref?.();
		// Observe rejections even if cancellation has already won the race.
		promise.then(
			(value) => finish({ kind: "value", value }),
			(error) => finish({ kind: "error", error }),
		);
		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) finish({ kind: "aborted" });
		}
	});
}

/**
 * Attach provenance to the brief text.
 *
 * `provenance` wins over the result's own model: the model brief must report the
 * model the inference actually ran on, never the child's declared model.
 */
function briefWithSource(
	result: RecoveryBriefResultLike,
	text: string,
	source: RecoveryBrief["source"],
	options: { reason?: string; model?: string; thinking?: string; usage?: RecoveryBriefUsage } = {},
): RecoveryBrief {
	const model = options.model ?? result.model;
	const thinking = options.thinking ?? result.thinking;
	return {
		text,
		source,
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		...(options.reason ? { reason: options.reason } : {}),
		...(options.usage ? { usage: options.usage } : {}),
	};
}

/**
 * Fold measured inference usage into the child's accounting exactly once.
 *
 * `turns` is intentionally untouched: the brief inference is not a child
 * execution turn, so it must not add a phantom turn (or tool call).
 */
export function foldRecoveryBriefUsage(
	target: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number },
	usage: RecoveryBriefUsage | undefined,
): boolean {
	if (!usage) return false;
	const add = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);
	target.input += add(usage.input);
	target.output += add(usage.output);
	target.cacheRead += add(usage.cacheRead);
	target.cacheWrite += add(usage.cacheWrite);
	target.cost += add(usage.cost);
	return true;
}

/** Result of applying a brief: the brief (when one should be shown) and usage. */
export interface RecoveryBriefApplication {
	brief?: RecoveryBrief;
	/** Measured usage to fold into the child exactly once, even when cancelled. */
	usage?: RecoveryBriefUsage;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Produce the brief for a finished child. The caller owns attaching the result;
 * nothing here mutates `result`.
 *
 * Cancellation during inference suppresses the late brief but still returns any
 * usage the generator managed to report before it was aborted.
 */
export async function applyRecoveryBrief(input: ApplyRecoveryBriefInput): Promise<RecoveryBriefApplication> {
	const { result } = input;
	if (!shouldGenerateRecoveryBrief(triggerInputFor(result, input.aborted === true, input.detached === true))) return {};

	// Cancellation wins over everything: never start an inference the parent
	// already walked away from (and never build evidence for it either).
	if (input.aborted || input.signal?.aborted) return {};

	// Evidence is rendered only after the trigger guard, so a successful child
	// never pays for the timeline flatten and phase render.
	const evidence = buildRecoveryBriefEvidence(input.evidenceInput);
	const fallback = (reason: string, usage?: RecoveryBriefUsage): RecoveryBrief =>
		briefWithSource(result, deterministicRecoveryBrief(evidence), "fallback", {
			reason,
			...(usage ? { usage } : {}),
		});

	// A configured usage budget means extra spend is not authorized; the
	// deterministic brief is the honest option.
	if (input.inferenceBudgetConfigured) return { brief: fallback("usage-budget-configured") };
	if (!input.generator) return { brief: fallback("no-generator") };

	const controller = new AbortController();
	const onParentAbort = () => controller.abort();
	if (input.signal) {
		input.signal.addEventListener("abort", onParentAbort, { once: true });
	}
	let generatorPromise: Promise<RecoveryBriefGenerationOutcome>;
	try {
		generatorPromise = input.generator({
			...(result.model ? { model: result.model } : {}),
			...(result.thinking ? { thinking: result.thinking } : {}),
			prompt: buildRecoveryBriefPrompt(evidence),
			signal: controller.signal,
		});
	} catch (error) {
		input.signal?.removeEventListener("abort", onParentAbort);
		return { brief: fallback(errorMessage(error)) };
	}

	try {
		const outcome = await raceWithDeadline(
			generatorPromise,
			input.deadlineMs ?? RECOVERY_BRIEF_DEADLINE_MS,
			input.signal,
		);

		if (outcome.kind === "aborted") {
			controller.abort();
			// Give the generator one bounded grace window to report usage it
			// already spent; the brief itself is suppressed.
			const late = await raceWithDeadline(generatorPromise, RECOVERY_BRIEF_ABORT_USAGE_GRACE_MS);
			const usage = late.kind === "value" ? late.value.usage : undefined;
			return usage ? { usage } : {};
		}
		if (outcome.kind === "timeout") {
			controller.abort();
			// Abort can finalize a partial provider response with billable usage.
			const late = await raceWithDeadline(generatorPromise, RECOVERY_BRIEF_ABORT_USAGE_GRACE_MS);
			const usage = late.kind === "value" ? late.value.usage : undefined;
			return {
				...(input.signal?.aborted ? {} : { brief: fallback("deadline-exceeded", usage) }),
				...(usage ? { usage } : {}),
			};
		}
		if (outcome.kind === "error") {
			return { brief: fallback(errorMessage(outcome.error)) };
		}

		const generated = outcome.value;
		// The parent may have cancelled while the generator was unwinding; a late
		// brief must never be attached after cancellation.
		if (input.aborted || input.signal?.aborted) {
			return generated.usage ? { usage: generated.usage } : {};
		}
		if (generated.ok === false) {
			return {
				brief: fallback(generated.reason, generated.usage),
				...(generated.usage ? { usage: generated.usage } : {}),
			};
		}
		const text = generated.text.trim();
		if (!text) {
			return {
				brief: fallback("empty-model-output", generated.usage),
				...(generated.usage ? { usage: generated.usage } : {}),
			};
		}
		// Report what actually produced the text, not what the child declared.
		return {
			brief: briefWithSource(result, text, "model", {
				...(generated.model ? { model: generated.model } : {}),
				...(generated.thinking ? { thinking: generated.thinking } : {}),
				...(generated.usage ? { usage: generated.usage } : {}),
			}),
			...(generated.usage ? { usage: generated.usage } : {}),
		};
	} catch (error) {
		return { brief: fallback(errorMessage(error)) };
	} finally {
		input.signal?.removeEventListener("abort", onParentAbort);
	}
}

export interface RecoveryBriefReferences {
	runId?: string;
	sessionFile?: string;
	transcriptPath?: string;
	outputPath?: string;
}

export type RecoveryBriefResumability =
	| { state: "resumable" }
	| { state: "not-resumable"; reason: string };

export interface FormatRecoveryBriefInput {
	references: RecoveryBriefReferences;
	resumability: RecoveryBriefResumability;
}

/**
 * Render the parent-facing block: the brief, the authoritative references the
 * host knows (never model-invented), and continuation advice that matches the
 * real resumability of this child.
 */
export function formatRecoveryBriefBlock(
	brief: RecoveryBrief,
	input: FormatRecoveryBriefInput,
): string {
	const { references, resumability } = input;
	const lines: string[] = [brief.text.trim(), ""];
	const refs: string[] = [];
	if (references.runId) refs.push(`- Run id: ${references.runId}`);
	if (references.sessionFile) refs.push(`- Child session: ${references.sessionFile}`);
	if (references.transcriptPath) refs.push(`- Execution log: ${references.transcriptPath}`);
	if (references.outputPath) refs.push(`- Output artifact: ${references.outputPath}`);
	if (refs.length > 0) lines.push("### References", ...refs, "");

	if (resumability.state === "resumable") {
		lines.push(
			"### Continuing this child",
			references.runId
				? `To continue or correct this work, call subagent({ action: "resume", id: "${references.runId}", message: "..." }).`
				: "To continue or correct this work, call subagent({ action: \"resume\", message: \"...\" }) with this run's id.",
			"Resuming continues the same child session under a new run id; it does not restart the task from scratch.",
		);
	} else {
		lines.push(
			"### Continuing this child",
			`This child cannot be resumed in its original session (${resumability.reason}).`,
			"Inspect the recorded failure and existing work before deciding how to proceed.",
		);
	}
	return lines.join("\n").trim();
}
