import { atom } from "jotai";
import type { ModelConfigurationScope, ModelReference, SessionEnvironment } from "../../../shared/types";
import { modelConfigurationScopeKey } from "../utils/modelConfigurationScope";

/**
 * 模型列表版本号。
 *
 * 主进程在「保存 models.json / 切换 pi 运行时」后重取模型缓存，
 * 并广播 models:changed；渲染层收到后递增本版本号，让依赖模型能力的功能
 * （视觉桥图片能力判定、模型选择器）立即改用新列表，而不是等重启。
 */
export const modelListRevisionAtom = atom(0);

/** The model configuration UI follows the active native or WSL source. */
export const modelConfigurationEnvironmentAtom = atom<SessionEnvironment>("native");

export const modelConfigurationWslIdentityAtom = atom<Pick<ModelConfigurationScope, "wslDistro" | "wslUser">>({});

/** Complete active configuration identity, including WSL account changes within the same environment. */
export const modelConfigurationScopeAtom = atom<ModelConfigurationScope>((get) => ({
	environment: get(modelConfigurationEnvironmentAtom),
	...get(modelConfigurationWslIdentityAtom),
}));

/** Keep request generations after an identity is removed and later added again. */
export const modelConfigurationVersionsByScopeAtom = atom<Record<string, Record<string, number>>>({
	native: {},
	wsl: {},
});

/** Only removals invalidate a saved default snapshot; edits to model metadata leave its choice valid. */
export const modelRemovalVersionsByScopeAtom = atom<Record<string, Record<string, number>>>({
	native: {},
	wsl: {},
});

/** Live session selections must only be invalidated in their own runtime environment. */
export const removedModelReferencesByScopeAtom = atom<Record<string, ModelReference[]>>({
	native: [],
	wsl: [],
});

/** Confirmed removals in the active configuration, retained until the identity is restored. */
const NO_REMOVALS: ModelReference[] = [];
export const removedModelReferencesAtom = atom((get) =>
	get(removedModelReferencesByScopeAtom)[modelConfigurationScopeKey(get(modelConfigurationScopeAtom))] ?? NO_REMOVALS,
);

/** Git, vision and subagent preferences are stored once for both environments. */
export const sharedRemovedModelReferencesAtom = atom<ModelReference[]>([]);

/** Shared preferences must not be restored by an old save after deletion and re-addition in any scope. */
export const sharedModelRemovalVersionsAtom = atom<Record<string, number>>({});
