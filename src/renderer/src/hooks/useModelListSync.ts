import { useEffect, useRef } from "react";
import { useSetAtom, useStore } from "jotai";
import type { AppSettings, ModelConfigurationScope, ModelReference, SessionEnvironment } from "../../../shared/types";
import {
	modelConfigurationEnvironmentAtom,
	modelConfigurationVersionsByScopeAtom,
	modelConfigurationWslIdentityAtom,
	modelListRevisionAtom,
	modelRemovalVersionsByScopeAtom,
	removedModelReferencesByScopeAtom,
	sharedRemovedModelReferencesAtom,
	sharedModelRemovalVersionsAtom,
} from "../atoms/model-atoms";
import { sessionRecordsAtom, sessionRuntimeByIdAtom } from "../atoms/session-atoms";
import { modelPendingByIdAtom } from "../atoms/composer-atoms";
import { visionBridgeCapabilitiesAtom, visionBridgeRequestSeqAtom } from "../atoms/vision-atoms";
import { desktopApi } from "../desktopApi";
import { clearAppModelReferences, clearRemovedModelReferences, isRemovedModel } from "../utils/modelSelection";
import { readWelcomeModelPreference, WELCOME_MODEL_KEY } from "../utils/chatSessionBootstrap";
import { modelConfigurationScopeKey } from "../utils/modelConfigurationScope";

/**
 * 订阅主进程的模型列表更新（models:changed），并递增版本号。
 *
 * 代价说明：主进程只在配置保存/运行时切换后广播，不是高频事件；
 * 挂载点必须唯一（App 装配层），避免重复订阅同一事件。
 */
export function useModelListSync(
	onSettingsChange?: (update: (settings: AppSettings) => AppSettings) => void,
	environment: SessionEnvironment = "native",
	wslIdentity: Pick<ModelConfigurationScope, "wslDistro" | "wslUser"> = {},
): void {
	const bumpRevision = useSetAtom(modelListRevisionAtom);
	const store = useStore();
	const onSettingsChangeRef = useRef(onSettingsChange);
	onSettingsChangeRef.current = onSettingsChange;
	const environmentRef = useRef(environment);
	environmentRef.current = environment;
	const scopeRef = useRef<ModelConfigurationScope>({ environment, ...wslIdentity });
	scopeRef.current = { environment, ...wslIdentity };
	const { wslDistro, wslUser } = wslIdentity;

	useEffect(() => {
		store.set(modelConfigurationEnvironmentAtom, environment);
		store.set(modelConfigurationWslIdentityAtom, (previous) => previous.wslDistro === wslDistro && previous.wslUser === wslUser
			? previous : { wslDistro, wslUser });
	}, [environment, wslDistro, wslUser, store]);

	useEffect(
		() =>
			desktopApi.projects.onModelsChanged((change) => {
				bumpRevision((revision) => revision + 1);
				if (!change) return;
				const changedEnvironment = change.environment ?? environmentRef.current;
				const changedScope: ModelConfigurationScope = {
					environment: changedEnvironment,
					wslDistro: change.wslDistro,
					wslUser: change.wslUser,
				};
				const scopeKey = modelConfigurationScopeKey(changedScope);
				const removed = change.removedModels ?? [];
				const changed = change.changedModels ?? [];
				// Removal followed by re-adding the same identity must not validate an older command result.
				store.set(modelConfigurationVersionsByScopeAtom, (previous) => {
					const versions = { ...previous[scopeKey] };
					for (const model of [...removed, ...changed]) {
						const key = JSON.stringify([model.provider, model.modelId]);
						versions[key] = (versions[key] ?? 0) + 1;
					}
					return { ...previous, [scopeKey]: versions };
				});
				const updateRemoved = (previous: ModelReference[]) => [
					...previous.filter((model) => !isRemovedModel(model, changed) && !isRemovedModel(model, removed)),
					...removed,
				];
				store.set(removedModelReferencesByScopeAtom, (previous) => ({
					...previous, [scopeKey]: updateRemoved(previous[scopeKey] ?? []),
				}));
				store.set(sharedRemovedModelReferencesAtom, updateRemoved);
				if (!removed.length) return;
				store.set(modelRemovalVersionsByScopeAtom, (previous) => {
					const versions = { ...previous[scopeKey] };
					for (const model of removed) {
						const key = JSON.stringify([model.provider, model.modelId]);
						versions[key] = (versions[key] ?? 0) + 1;
					}
					return { ...previous, [scopeKey]: versions };
				});
				store.set(sharedModelRemovalVersionsAtom, (previous) => {
					const versions = { ...previous };
					for (const model of removed) {
						const key = JSON.stringify([model.provider, model.modelId]);
						versions[key] = (versions[key] ?? 0) + 1;
					}
					return versions;
				});
				// The initial capability read may still be pending with config === null,
				// or its consumers may be unmounted. Invalidate it before any new effect runs.
				store.set(visionBridgeRequestSeqAtom, (previous) => previous + 1);
				const records = store.get(sessionRecordsAtom);
				const runtimes = store.get(sessionRuntimeByIdAtom);
				const affectedRecords = Object.values(records).filter(
					(record) => modelConfigurationScopeKey(record) === scopeKey,
				);
				const affectedIds = new Set(affectedRecords.map((record) => record.id));
				const pending = store.get(modelPendingByIdAtom);
				const next = clearRemovedModelReferences(
					affectedRecords.map((record) => !record.model && isRemovedModel(runtimes[record.id]?.state, removed)
						? { ...record, model: { provider: "", modelId: "" } } : record),
					Object.fromEntries(Object.entries(pending).filter(([id]) => affectedIds.has(id))), removed,
				);
				store.set(sessionRecordsAtom, { ...records, ...Object.fromEntries(next.records.map((record) => [record.id, record])) });
				store.set(modelPendingByIdAtom, {
					...Object.fromEntries(Object.entries(pending).filter(([id]) => !affectedIds.has(id))), ...next.pending,
				});
				store.set(sessionRuntimeByIdAtom, (previous) => Object.fromEntries(
					Object.entries(previous).map(([id, runtime]) => [id,
						affectedIds.has(id) && isRemovedModel(runtime.state, removed)
							? { ...runtime, state: { ...runtime.state, provider: "", modelId: "", modelName: "" } }
							: runtime,
					]),
				));
				const capabilities = store.get(visionBridgeCapabilitiesAtom);
				let config = capabilities.config;
				if (config && isRemovedModel({ provider: config.provider, modelId: config.model }, removed)) {
					config = { ...config, provider: "", model: "" };
					delete config.api;
					delete config.baseUrl;
					delete config.apiKey;
				}
				store.set(visionBridgeCapabilitiesAtom, { ...capabilities, config, loadKey: "" });
				try {
					if (scopeKey === modelConfigurationScopeKey(scopeRef.current) && isRemovedModel(readWelcomeModelPreference()?.model, removed)) {
						localStorage.removeItem(WELCOME_MODEL_KEY);
					}
				} catch { /* Storage can be unavailable in restricted web views. */ }
				// Apply only the invalidated references to the current snapshot. An async
				// whole-settings reload could overwrite an unrelated change made meanwhile.
				onSettingsChangeRef.current?.((settings) => clearAppModelReferences(settings, removed));
			}),
		[bumpRevision, store],
	);
}
