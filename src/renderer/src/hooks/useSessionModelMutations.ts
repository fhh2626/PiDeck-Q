import { useStore } from "jotai";
import { useEffect, useRef } from "react";
import type { ModelReference, SessionRuntimeTarget } from "../../../shared/types";
import { isExtendedThinkingLevel } from "../../../shared/thinkingLevelSupport";
import { sessionRecordByIdAtomFamily, sessionRuntimeByIdAtom, upsertSessionAtom } from "../atoms";
import {
	modelConfigurationScopeAtom,
	modelConfigurationVersionsByScopeAtom,
	removedModelReferencesByScopeAtom,
} from "../atoms/model-atoms";
import { desktopApi } from "../desktopApi";
import { isRemovedModel } from "../utils/modelSelection";
import { isSameSessionRuntimeTarget, toSessionRuntimeTarget } from "../utils/sessionCommands";
import { modelConfigurationScopeKey } from "../utils/modelConfigurationScope";

export type ModelSelectionOperation = {
	sessionId: string;
	scopeKey: string;
	model: ModelReference;
	version: number;
	sequence: number;
	target?: SessionRuntimeTarget;
};

type ModelState = {
	provider?: string;
	modelId?: string;
	modelName?: string;
	thinkingLevel?: string;
};

/** Commit only the fields owned by a current selection, after checking its session, runtime and configuration. */
export function useSessionModelMutations(sessionId: string) {
	const store = useStore();
	const activeRef = useRef(true);
	const sessionIdRef = useRef(sessionId);
	const sequenceRef = useRef(0);
	sessionIdRef.current = sessionId;
	useEffect(() => {
		activeRef.current = true;
		return () => { activeRef.current = false; };
	}, []);

	function currentHandle() {
		return toSessionRuntimeTarget(sessionId, store.get(sessionRuntimeByIdAtom)[sessionId]);
	}

	function currentScopeKey() {
		return modelConfigurationScopeKey(store.get(sessionRecordByIdAtomFamily(sessionId))
			?? store.get(modelConfigurationScopeAtom));
	}

	function currentRemovedModels() {
		return store.get(removedModelReferencesByScopeAtom)[currentScopeKey()] ?? [];
	}

	function currentVersion(model: ModelReference, scopeKey: string) {
		return store.get(modelConfigurationVersionsByScopeAtom)[scopeKey]?.[JSON.stringify([model.provider, model.modelId])] ?? 0;
	}

	function isCurrentRuntime(target: SessionRuntimeTarget | undefined) {
		if (!activeRef.current || sessionIdRef.current !== sessionId) return false;
		const current = currentHandle();
		return !target && !current || isSameSessionRuntimeTarget(target, current);
	}

	function beginModelSelection(model: ModelReference, target = currentHandle()): ModelSelectionOperation {
		const scopeKey = currentScopeKey();
		return { sessionId, scopeKey, model, target, version: currentVersion(model, scopeKey), sequence: ++sequenceRef.current };
	}

	function isModelSelectionCurrent(operation: ModelSelectionOperation) {
		return operation.sessionId === sessionId
			&& operation.sequence === sequenceRef.current
			&& isCurrentRuntime(operation.target)
			&& Boolean(store.get(sessionRecordByIdAtomFamily(sessionId)))
			&& operation.scopeKey === currentScopeKey()
			&& operation.version === currentVersion(operation.model, operation.scopeKey)
			&& !isRemovedModel(operation.model, currentRemovedModels());
	}

	async function applyModelToRecord(operation: ModelSelectionOperation, thinkingLevel?: string) {
		if (!isModelSelectionCurrent(operation)) return false;
		const updated = await desktopApi.sessions.updateRecord(sessionId, {
			model: operation.model,
			...(thinkingLevel ? { thinkingLevel } : {}),
		});
		if (!isModelSelectionCurrent(operation)) return false;
		const current = store.get(sessionRecordByIdAtomFamily(sessionId));
		if (!current) return false;
		// The catalog response contains a whole record. Concurrent edits and deletion events own its other fields.
		store.set(upsertSessionAtom, {
			...current,
			model: updated.model,
			...(thinkingLevel ? { thinkingLevel: updated.thinkingLevel } : {}),
			updatedAt: Math.max(current.updatedAt, updated.updatedAt),
		});
		return true;
	}

	function applyRuntimeModelState(agentState: ModelState, target: SessionRuntimeTarget) {
		if (!isCurrentRuntime(target) || isRemovedModel(agentState, currentRemovedModels())) return;
		const current = store.get(sessionRuntimeByIdAtom)[sessionId];
		if (!current) return;
		const modelState = {
			...(agentState.provider !== undefined ? { provider: agentState.provider } : {}),
			...(agentState.modelId !== undefined ? { modelId: agentState.modelId, modelName: agentState.modelName ?? agentState.modelId } : {}),
			...(agentState.thinkingLevel !== undefined ? { thinkingLevel: agentState.thinkingLevel } : {}),
		};
		store.set(sessionRuntimeByIdAtom, {
			...store.get(sessionRuntimeByIdAtom),
			[sessionId]: { ...current, state: { ...current.state, ...modelState } },
		});
		const record = store.get(sessionRecordByIdAtomFamily(sessionId));
		const thinking = agentState.thinkingLevel;
		if (record?.thinkingLevel && thinking && isExtendedThinkingLevel(record.thinkingLevel) && record.thinkingLevel !== thinking) {
			store.set(upsertSessionAtom, { ...record, thinkingLevel: thinking, updatedAt: Date.now() });
		}
	}

	function commitRuntimeModel(operation: ModelSelectionOperation, state: ModelState, fallbackThinking?: string) {
		if (!isModelSelectionCurrent(operation) || !operation.target) return false;
		const current = store.get(sessionRecordByIdAtomFamily(sessionId));
		if (!current) return false;
		const thinking = state.thinkingLevel || fallbackThinking;
		const persistThinking = thinking && current.thinkingLevel
			&& isExtendedThinkingLevel(current.thinkingLevel) && thinking !== current.thinkingLevel;
		store.set(upsertSessionAtom, {
			...current,
			model: operation.model,
			...(persistThinking ? { thinkingLevel: thinking } : {}),
			updatedAt: Date.now(),
		});
		applyRuntimeModelState(state, operation.target);
		return true;
	}

	function commitThinking(level: string, target: SessionRuntimeTarget | undefined) {
		if (!isCurrentRuntime(target)) return false;
		const record = store.get(sessionRecordByIdAtomFamily(sessionId));
		if (!record) return false;
		store.set(upsertSessionAtom, { ...record, thinkingLevel: level, updatedAt: Date.now() });
		if (target) {
			const current = store.get(sessionRuntimeByIdAtom)[sessionId];
			if (current) store.set(sessionRuntimeByIdAtom, {
				...store.get(sessionRuntimeByIdAtom),
				[sessionId]: { ...current, state: { ...current.state, thinkingLevel: level } },
			});
		}
		return true;
	}

	return { currentHandle, currentRemovedModels, beginModelSelection, isModelSelectionCurrent, isCurrentRuntime, applyModelToRecord, applyRuntimeModelState, commitRuntimeModel, commitThinking };
}
