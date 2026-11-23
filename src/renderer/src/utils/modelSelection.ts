import type { AgentRuntimeState, AppSettings, ModelReference } from "../../../shared/types";
import type { ModelPending } from "./modelPendingDisplay";

/** Compare complete identities so two providers may safely expose the same model id. */
export function isRemovedModel(model: Partial<ModelReference> | undefined, removed: readonly ModelReference[]): boolean {
	return Boolean(model?.provider && model.modelId && removed.some(
		(item) => item.provider === model.provider && item.modelId === model.modelId,
	));
}

/** Include deletions that were followed by re-addition while a shared preference request was pending. */
export function getModelRemovalsSince(
	previous: Readonly<Record<string, number>>,
	current: Readonly<Record<string, number>>,
): ModelReference[] {
	const removed: ModelReference[] = [];
	for (const [key, version] of Object.entries(current)) {
		if (version === (previous[key] ?? 0)) continue;
		try {
			const identity: unknown = JSON.parse(key);
			if (Array.isArray(identity) && identity.length === 2
				&& typeof identity[0] === "string" && typeof identity[1] === "string") {
				removed.push({ provider: identity[0], modelId: identity[1] });
			}
		} catch { /* Ignore an invalid identity rather than applying it to an unrelated preference. */ }
	}
	return removed;
}

/** An explicit empty saved choice masks pi's old in-memory selection after a deletion. */
export function resolveSelectedModel(
	stored: ModelReference | undefined,
	live?: Pick<AgentRuntimeState, "provider" | "modelId" | "modelName">,
) {
	if (stored && (!stored.provider || !stored.modelId)) {
		return { provider: "", modelId: "", modelName: "" };
	}
	return {
		provider: live?.provider ?? stored?.provider ?? "",
		modelId: live?.modelId ?? stored?.modelId ?? "",
		modelName: live?.modelName ?? stored?.modelId,
	};
}

/** Clear only references explicitly removed by a successful model config write. */
export function clearRemovedModelReferences<T extends { id: string; model?: ModelReference }>(
	records: readonly T[],
	pending: Record<string, ModelPending | undefined>,
	removed: readonly ModelReference[],
) {
	const nextRecords = records.map((record) => isRemovedModel(record.model, removed)
		? { ...record, model: { provider: "", modelId: "" } }
		: record);
	const nextPending = { ...pending };
	for (const [id, value] of Object.entries(nextPending)) {
		if (!value) continue;
		if (isRemovedModel(value.to, removed)) {
			delete nextPending[id];
		} else if (isRemovedModel(value.from, removed)) {
			// A valid queued replacement still needs to reach pi after its current turn.
			nextPending[id] = { ...value, from: { provider: "", modelId: "" } };
		}
	}
	return { records: nextRecords, pending: nextPending };
}

/** Keep an open settings draft from restoring deleted Git and favorite selections. */
export function clearAppModelReferences(settings: AppSettings, removed: readonly ModelReference[]): AppSettings {
	const clearGit = isRemovedModel({ provider: settings.gitCommitMessageProvider, modelId: settings.gitCommitMessageModel }, removed);
	const previousFavorites = settings.favoriteModels ?? [];
	const favoriteModels = previousFavorites.filter((key) => !removed.some((model) => key === `${model.provider}/${model.modelId}`));
	if (!clearGit && favoriteModels.length === previousFavorites.length) return settings;
	return {
		...settings,
		...(clearGit ? { gitCommitMessageProvider: "", gitCommitMessageModel: "" } : {}),
		favoriteModels,
	};
}

/** Clear exact defaults in the editable pi settings object without replacing other edits. */
export function clearPiModelDefaults(settings: Record<string, unknown>, removed: readonly ModelReference[]): Record<string, unknown> {
	const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : "";
	const rawModel = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
	const modelId = provider && rawModel.startsWith(`${provider}/`) ? rawModel.slice(provider.length + 1) : rawModel;
	const removedDefault = isRemovedModel({ provider, modelId }, removed)
		|| (!provider && removed.some((model) => rawModel === `${model.provider}/${model.modelId}`));
	let next = removedDefault
		? { ...settings, defaultProvider: "", defaultModel: "" } : settings;
	const block = settings.subagents;
	if (block && typeof block === "object" && !Array.isArray(block)) {
		const values = Object.fromEntries(Object.entries(block));
		const updated = clearPiModelDefaults(values, removed);
		if (updated !== values) next = { ...next, subagents: updated };
	}
	return next;
}
