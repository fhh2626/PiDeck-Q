import type { Getter } from "jotai";
import type { SessionRecord } from "../../../shared/types";
import { modelConfigurationVersionsByScopeAtom, removedModelReferencesByScopeAtom } from "./model-atoms";
import { modelConfigurationScopeKey } from "../utils/modelConfigurationScope";
import { isRemovedModel } from "../utils/modelSelection";

export type SessionModelVersions = Record<string, Record<string, number>>;

/** A catalog snapshot cannot restore a selection invalidated while its request was pending. */
export function clearStaleSessionModel(
	get: Getter,
	session: SessionRecord,
	previous: SessionRecord | undefined,
	versions?: SessionModelVersions,
): SessionRecord {
	const scopeKey = modelConfigurationScopeKey(session);
	const removed = get(removedModelReferencesByScopeAtom)[scopeKey] ?? [];
	const model = session.model;
	const modelKey = model ? JSON.stringify([model.provider, model.modelId]) : "";
	const changedDuringRead = model?.provider && model.modelId && versions
		&& (versions[scopeKey]?.[modelKey] ?? 0) !== (get(modelConfigurationVersionsByScopeAtom)[scopeKey]?.[modelKey] ?? 0);
	if (isRemovedModel(model, removed) || changedDuringRead) {
		const replacement = previous && modelConfigurationScopeKey(previous) === scopeKey
			&& previous.model && !isRemovedModel(previous.model, removed) ? previous.model : { provider: "", modelId: "" };
		return { ...session, model: replacement };
	}
	// Old records without preferences must not undo a deletion's explicit empty choice.
	if (!model && previous?.model?.provider === "" && previous.model.modelId === "") {
		return { ...session, model: previous.model };
	}
	return session;
}
