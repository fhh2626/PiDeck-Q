import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../../shared/types";
import {
	modelConfigurationScopeAtom,
	removedModelReferencesAtom,
	sharedModelRemovalVersionsAtom,
	sharedRemovedModelReferencesAtom,
} from "../atoms/model-atoms";
import { modelConfigurationScopeKey } from "../utils/modelConfigurationScope";
import { clearAppModelReferences, getModelRemovalsSince, isRemovedModel } from "../utils/modelSelection";
import { showNotice } from "../utils/notice";

export type SaveAppSettings = (patch: Partial<AppSettings>) => void | boolean | Promise<void | boolean>;

/** Own an editable settings snapshot and commit only the fields acknowledged by its current save. */
export function useSettingsDraft(settings: AppSettings, onChange: SaveAppSettings) {
	const store = useStore();
	const [draft, setDraft] = useState<AppSettings>(() => ({ ...settings }));
	const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);
	const activeRef = useRef(true);
	const baseRef = useRef({ ...settings });
	const fieldVersionsRef = useRef<Record<string, number>>({});
	const editRevisionRef = useRef(0);
	const removed = useAtomValue(sharedRemovedModelReferencesAtom);
	useEffect(() => {
		setDraft((current) => clearAppModelReferences(current, removed));
		baseRef.current = clearAppModelReferences(baseRef.current, removed);
	}, [removed]);
	useEffect(() => {
		activeRef.current = true;
		return () => { activeRef.current = false; };
	}, []);

	const update = useCallback((patch: Partial<AppSettings>) => {
		editRevisionRef.current += 1;
		for (const key of Object.keys(patch)) fieldVersionsRef.current[key] = (fieldVersionsRef.current[key] ?? 0) + 1;
		setDraft((current) => ({ ...current, ...patch }));
		setDirtyFields((current) => new Set([...current, ...Object.keys(patch)]));
	}, []);
	const isDirty = useCallback((field: keyof AppSettings) => dirtyFields.has(String(field)), [dirtyFields]);

	async function save(): Promise<boolean> {
		if (savingRef.current) return false;
		if (!dirtyFields.size) return true;
		const cleaned = clearAppModelReferences(draft, store.get(removedModelReferencesAtom));
		if (cleaned !== draft) setDraft(cleaned);
		const patch: Partial<AppSettings> = Object.fromEntries(Object.entries(cleaned).filter(([key]) => dirtyFields.has(key)));
		const fieldVersions = { ...fieldVersionsRef.current };
		const removalVersions = store.get(sharedModelRemovalVersionsAtom);
		const oldRemovals = new Set(store.get(sharedRemovedModelReferencesAtom));
		const scopeKey = modelConfigurationScopeKey(store.get(modelConfigurationScopeAtom));
		savingRef.current = true;
		setSaving(true);
		try {
			if (await onChange(patch) === false) return false;
			const removedSince = getModelRemovalsSince(removalVersions, store.get(sharedModelRemovalVersionsAtom));
			if (scopeKey === modelConfigurationScopeKey(store.get(modelConfigurationScopeAtom))) {
				const currentRemovals = store.get(removedModelReferencesAtom);
				store.set(sharedRemovedModelReferencesAtom, (current) => current.filter((model) => {
					const chosen = patch.gitCommitMessageProvider === model.provider && patch.gitCommitMessageModel === model.modelId
						|| patch.favoriteModels?.includes(`${model.provider}/${model.modelId}`);
					return !oldRemovals.has(model) || !chosen
						|| isRemovedModel(model, currentRemovals) || isRemovedModel(model, removedSince);
				}));
			}
			baseRef.current = clearAppModelReferences({ ...baseRef.current, ...patch }, [
				...store.get(sharedRemovedModelReferencesAtom), ...removedSince,
			]);
			if (!activeRef.current) return true;
			setDirtyFields((current) => new Set([...current].filter((key) => fieldVersions[key] !== fieldVersionsRef.current[key])));
			// A user may keep editing while a save is in flight. Keep those edits open and dirty.
			return Object.entries(fieldVersionsRef.current).every(([key, version]) => fieldVersions[key] === version);
		} catch (error) {
			if (activeRef.current) showNotice(error instanceof Error ? error.message : String(error), 4000);
			return false;
		} finally {
			savingRef.current = false;
			if (activeRef.current) setSaving(false);
		}
	}

	function reset() {
		editRevisionRef.current += 1;
		const baseline = { ...baseRef.current };
		setDraft(baseline);
		setDirtyFields(new Set());
		return baseline;
	}

	const getEditRevision = useCallback(() => editRevisionRef.current, []);
	return { draft, update, isDirty, dirty: dirtyFields.size > 0, saving, save, reset, getEditRevision };
}
