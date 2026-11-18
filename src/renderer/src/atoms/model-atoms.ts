import { atom } from "jotai";
import type { ModelReference, SessionEnvironment } from "../../../shared/types";

/**
 * 模型列表版本号。
 *
 * 主进程在「保存 models.json / auth.json / 切换 pi 运行时」后重取模型缓存，
 * 并广播 models:changed；渲染层收到后递增本版本号，让依赖模型能力的功能
 * （视觉桥图片能力判定、模型选择器）立即改用新列表，而不是等重启。
 */
export const modelListRevisionAtom = atom(0);

/** The model configuration UI follows the active native or WSL source. */
export const modelConfigurationEnvironmentAtom = atom<SessionEnvironment>("native");

/** Live session selections must only be invalidated in their own runtime environment. */
export const removedModelReferencesByEnvironmentAtom = atom<Record<SessionEnvironment, ModelReference[]>>({
	native: [],
	wsl: [],
});

/** Confirmed removals in the active configuration, retained until the identity is restored. */
export const removedModelReferencesAtom = atom((get) =>
	get(removedModelReferencesByEnvironmentAtom)[get(modelConfigurationEnvironmentAtom)],
);

/** Git, vision and subagent preferences are stored once for both environments. */
export const sharedRemovedModelReferencesAtom = atom<ModelReference[]>([]);
