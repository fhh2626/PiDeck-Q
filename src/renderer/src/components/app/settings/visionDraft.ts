/**
 * 视觉桥草稿状态 hook（设置弹框持有）与共享常量。
 *
 * 独立成文件的原因：壳组件（SettingsModal）需要 hook（脏标记/保存统一管理），
 * 但 VisionBridgeSettingsTab 组件应能 lazy 加载——若 hook 与组件同文件，
 * 壳的静态 import 会把整个 tab（含 ModelPicker 等重依赖）拖进首开 chunk。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { modelConfigurationScopeAtom, removedModelReferencesByScopeAtom, sharedModelRemovalVersionsAtom, sharedRemovedModelReferencesAtom } from "../../../atoms/model-atoms";
import { isRemovedModel } from "../../../utils/modelSelection";
import { modelConfigurationScopeKey } from "../../../utils/modelConfigurationScope";
import type { ModelReference, VisionBridgeConfig, VisionBridgeState } from "../../../../../shared/types";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { visionConfigRevisionAtom } from "../../../atoms/session-atoms";
import { commitVisionBridgeConfigAtom, visionBridgeCommittedSaveSequenceAtom, visionBridgeSaveSequenceAtom } from "../../../atoms/vision-atoms";

/** 与扩展 DEFAULT_PROMPT 保持一致（恢复默认按钮用）。 */
export const DEFAULT_PROMPT =
	"请详细描述这张图片的内容。如果图片中有文字（代码、报错、UI 文案、文档等），请完整准确地转录所有可见文字；如果是图表，请说明类型、坐标轴含义和关键数值；如果涉及界面，请描述布局与元素。输出使用中文。";

/** 超时默认值（ms），与主进程/扩展 DEFAULT_CONFIG 保持一致；UI 以秒为单位展示。 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** 配置文件路径（来自主进程返回的 configDir，与扩展读取路径一致）。 */
export function configFilePath(configDir: string): string {
	return `${configDir}/pi-deck-vision.json`;
}

/** 未配置时的新建草稿（provider/model 留空，保存按钮不可点，引导先选模型）。 */
export function emptyDraft(): VisionBridgeConfig {
	return { enabled: true, provider: "", model: "" };
}

/** The host vision configuration is shared by both model environments. */
function clearRemovedModel(config: VisionBridgeConfig | null, removedModels: readonly ModelReference[]): VisionBridgeConfig | null {
	if (!config || !isRemovedModel({ provider: config.provider, modelId: config.model }, removedModels)) return config;
	const next = { ...config, provider: "", model: "" };
	// These overrides belong to the deleted provider and must never follow a replacement choice.
	delete next.api;
	delete next.baseUrl;
	delete next.apiKey;
	return next;
}

/**
 * 视觉桥草稿状态 hook（设置弹框持有）：与全局设置草稿平行但独立存储
 * （视觉桥写入 pi-deck-vision.json，走独立 IPC，不是 AppSettings 字段），
 * 因此脏标记单独维护，由弹框头部统一保存/取消/关闭确认一并处理。
 */
export function useVisionBridgeDraft() {
	const store = useStore();
	const removedModels = useAtomValue(sharedRemovedModelReferencesAtom);
	const setVisionConfigRevision = useSetAtom(visionConfigRevisionAtom);
	const commitConfig = useSetAtom(commitVisionBridgeConfigAtom);
	const [state, setState] = useState<VisionBridgeState | null>(null);
	const [draft, setDraft] = useState<VisionBridgeConfig | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const draftActionRef = useRef({ revision: 0, edited: false });
	const saveInFlightRef = useRef(false);
	const getEditRevision = useCallback(() => draftActionRef.current.revision, []);
	// 保存失败提示（成功走全局 toast，不在此占位）
	const [notice, setNotice] = useState<string | null>(null);
	useEffect(() => {
		const clear = (config: VisionBridgeConfig | null) => clearRemovedModel(config, removedModels);
		setDraft(clear);
		setState((current) => current ? { ...current, config: clear(current.config) } : current);
	}, [removedModels]);

	// 挂载时拉取当前配置（弹框每次打开都重建 state，无需清理外部资源）
	useEffect(() => {
		let mounted = true;
		const removalVersions = store.get(sharedModelRemovalVersionsAtom);
		desktopApi.config
			.visionGetConfig()
			.then((loaded) => {
				if (!mounted) return;
				// Read the store at settlement, since removals can precede this initial response.
				const selected = loaded.config ? { provider: loaded.config.provider, modelId: loaded.config.model } : undefined;
				const selectionKey = selected ? JSON.stringify([selected.provider, selected.modelId]) : "";
				const removedDuringRead = selected
					&& (removalVersions[selectionKey] ?? 0) !== (store.get(sharedModelRemovalVersionsAtom)[selectionKey] ?? 0);
				const config = clearRemovedModel(loaded.config, removedDuringRead ? [selected] : store.get(sharedRemovedModelReferencesAtom));
				setState({ ...loaded, config });
				setDraft(config ?? emptyDraft());
				setLoading(false);
			})
			.catch(() => {
				if (mounted) setLoading(false);
			});
		return () => {
			mounted = false;
		};
	}, [store]);

	/** 表单改动：更新草稿并标记未保存（幂等）。 */
	const updateDraft = useCallback((patch: Partial<VisionBridgeConfig>) => {
		draftActionRef.current = { revision: draftActionRef.current.revision + 1, edited: true };
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
		setDirty(true);
		setNotice(null);
	}, []);

	/** 保存草稿到 pi-deck-vision.json；成功清脏标记并弹 toast，失败保留脏标记（头部按钮可重试）。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!draft || saveInFlightRef.current) return false;
		const scopeKey = modelConfigurationScopeKey(store.get(modelConfigurationScopeAtom));
		const selected = { provider: draft.provider, modelId: draft.model };
		const currentRemovals = store.get(removedModelReferencesByScopeAtom)[scopeKey] ?? [];
		if (isRemovedModel(selected, currentRemovals)) {
			setDraft((current) => clearRemovedModel(current, currentRemovals));
			setNotice(t("app.modelSelectionRequired"));
			return false;
		}
		const previousRemoval = store.get(sharedRemovedModelReferencesAtom).find(
			(model) => model.provider === selected.provider && model.modelId === selected.modelId,
		);
		const savedRevision = draftActionRef.current.revision;
		const selectionKey = JSON.stringify([selected.provider, selected.modelId]);
		const removalVersion = store.get(sharedModelRemovalVersionsAtom)[selectionKey] ?? 0;
		const saveSequence = store.get(visionBridgeSaveSequenceAtom) + 1;
		store.set(visionBridgeSaveSequenceAtom, saveSequence);
		saveInFlightRef.current = true;
		setSaving(true);
		setNotice(null);
		try {
			const result = await desktopApi.config.visionSaveConfig(draft);
			if (store.get(visionBridgeCommittedSaveSequenceAtom) > saveSequence) return false;
			if (result.ok) {
				store.set(visionBridgeCommittedSaveSequenceAtom, saveSequence);
				if ((store.get(sharedModelRemovalVersionsAtom)[selectionKey] ?? 0) !== removalVersion) {
					// Deleting in either environment clears the shared file. Re-adding
					// the identity cannot validate a response from before that deletion.
					setState((current) => current ? { ...current, config: clearRemovedModel(current.config, [selected]) } : current);
					if (draftActionRef.current.revision === savedRevision || !draftActionRef.current.edited) {
						setDraft((current) => clearRemovedModel(current, [selected]));
					}
					setNotice(t("app.visionModelSelectionRequired"));
					setVisionConfigRevision((c) => c + 1);
					return false;
				}
				// A valid explicit choice can replace a removal from the other environment.
				// New deletion events replace their entry object, so never erase one received during this save.
				if (previousRemoval && !isRemovedModel(selected, store.get(removedModelReferencesByScopeAtom)[scopeKey] ?? [])) {
					store.set(sharedRemovedModelReferencesAtom, (current) => current.includes(previousRemoval)
						? current.filter((model) => model !== previousRemoval) : current);
				}
				const savedConfig = clearRemovedModel(draft, store.get(sharedRemovedModelReferencesAtom));
				setState((current) => current ? { ...current, config: savedConfig } : current);
				// Save remains in this dialog. Cancel must return to this confirmed
				// baseline, while edits made during the write retain their dirty state.
				const savedCurrentDraft = draftActionRef.current.revision === savedRevision || !draftActionRef.current.edited;
				if (savedCurrentDraft) {
					setDraft(savedConfig);
					setDirty(false);
					draftActionRef.current.edited = false;
				}
				commitConfig(savedConfig);
				setVisionConfigRevision((c) => c + 1);
				showNotice(t("settings.vision.saved"), 3000);
				// The dialog's Save and Close action must stay open for newer unsaved edits.
				return savedCurrentDraft;
			}
			setNotice(`${t("settings.vision.saveFailed")}：${result.error ?? ""}`);
			return false;
		} catch (error) {
			setNotice(`${t("settings.vision.saveFailed")}：${String(error)}`);
			return false;
		} finally {
			saveInFlightRef.current = false;
			setSaving(false);
		}
	}, [draft, store, commitConfig, setVisionConfigRevision]);

	/** 放弃修改：回退到最近一次确认保存的磁盘配置快照。 */
	const reset = useCallback(() => {
		draftActionRef.current = { revision: draftActionRef.current.revision + 1, edited: false };
		setDraft(clearRemovedModel(state?.config ?? null, store.get(sharedRemovedModelReferencesAtom)) ?? emptyDraft());
		setDirty(false);
		setNotice(null);
	}, [state, store]);

	return { draft, loading, saving, dirty, notice, configDir: state?.configDir ?? "", updateDraft, save, reset, getEditRevision };
}
