/**
 * 视觉桥草稿状态 hook（设置弹框持有）与共享常量。
 *
 * 独立成文件的原因：壳组件（SettingsModal）需要 hook（脏标记/保存统一管理），
 * 但 VisionBridgeSettingsTab 组件应能 lazy 加载——若 hook 与组件同文件，
 * 壳的静态 import 会把整个 tab（含 ModelPicker 等重依赖）拖进首开 chunk。
 */
import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { modelConfigurationEnvironmentAtom, removedModelReferencesByEnvironmentAtom, sharedRemovedModelReferencesAtom } from "../../../atoms/model-atoms";
import { isRemovedModel } from "../../../utils/modelSelection";
import type { ModelReference, VisionBridgeConfig, VisionBridgeState } from "../../../../../shared/types";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { visionConfigRevisionAtom } from "../../../atoms/session-atoms";

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
	const [state, setState] = useState<VisionBridgeState | null>(null);
	const [draft, setDraft] = useState<VisionBridgeConfig | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
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
		desktopApi.config
			.visionGetConfig()
			.then((loaded) => {
				if (!mounted) return;
				// Read the store at settlement, since removals can precede this initial response.
				const config = clearRemovedModel(loaded.config, store.get(sharedRemovedModelReferencesAtom));
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
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
		setDirty(true);
		setNotice(null);
	}, []);

	/** 保存草稿到 pi-deck-vision.json；成功清脏标记并弹 toast，失败保留脏标记（头部按钮可重试）。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!draft) return false;
		const environment = store.get(modelConfigurationEnvironmentAtom);
		const selected = { provider: draft.provider, modelId: draft.model };
		const currentRemovals = store.get(removedModelReferencesByEnvironmentAtom)[environment];
		if (isRemovedModel(selected, currentRemovals)) {
			setDraft((current) => clearRemovedModel(current, currentRemovals));
			setNotice(t("app.modelSelectionRequired"));
			return false;
		}
		const previousRemoval = store.get(sharedRemovedModelReferencesAtom).find(
			(model) => model.provider === selected.provider && model.modelId === selected.modelId,
		);
		setSaving(true);
		setNotice(null);
		try {
			const result = await desktopApi.config.visionSaveConfig(draft);
			if (result.ok) {
				// A valid explicit choice can replace a removal from the other environment.
				// New deletion events replace their entry object, so never erase one received during this save.
				if (previousRemoval && !isRemovedModel(selected, store.get(removedModelReferencesByEnvironmentAtom)[environment])) {
					store.set(sharedRemovedModelReferencesAtom, (current) => current.includes(previousRemoval)
						? current.filter((model) => model !== previousRemoval) : current);
				}
				setDirty(false);
				setVisionConfigRevision((c) => c + 1);
				showNotice(t("settings.vision.saved"), 3000);
				return true;
			}
			setNotice(`${t("settings.vision.saveFailed")}：${result.error ?? ""}`);
			return false;
		} catch (error) {
			setNotice(`${t("settings.vision.saveFailed")}：${String(error)}`);
			return false;
		} finally {
			setSaving(false);
		}
	}, [draft, store]);

	/** 放弃修改：回退到打开弹框时的磁盘配置快照。 */
	const reset = useCallback(() => {
		setDraft(clearRemovedModel(state?.config ?? null, store.get(sharedRemovedModelReferencesAtom)) ?? emptyDraft());
		setDirty(false);
		setNotice(null);
	}, [state, store]);

	return { draft, loading, saving, dirty, notice, configDir: state?.configDir ?? "", updateDraft, save, reset };
}
