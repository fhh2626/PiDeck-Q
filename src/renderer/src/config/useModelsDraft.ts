import { useCallback, useRef, useState } from "react";
import type { ModelSpec } from "../../../shared/types/modelSpecs";
import { computeModelSpecPatches, type ModelSpecLookup } from "../utils/modelSpecAutoFill";
import type { ModelItem, ModelsFile, ProviderConfig } from "./configTypes";

/** Own the live draft and its transient row identity and catalog-field provenance. */
export function useModelsDraft() {
	const [modelsData, setData] = useState<ModelsFile>({ providers: {} });
	const current = useRef(modelsData);
	const rowMetadata = useRef(new WeakMap<ModelItem, { identity: ModelItem; catalogFields: ReadonlySet<string> }>());
	const providerRequests = useRef(new WeakMap<ProviderConfig, object>());
	// Async completions must see queued edits as well as the last rendered draft.
	const setModelsData = useCallback((next: ModelsFile | ((prev: ModelsFile) => ModelsFile)) => {
		const previous = current.current;
		const data = typeof next === "function" ? next(previous) : next;
		// Preserve pending requests across edits to the same provider, not deletion or rename.
		for (const [name, provider] of Object.entries(data.providers)) {
			const requestIdentity = providerRequests.current.get(previous.providers[name]);
			if (requestIdentity) providerRequests.current.set(provider, requestIdentity);
		}
		current.current = data;
		setData(data);
	}, []);

	/** Keep pending actions attached to the original provider through ordinary edits. */
	const providerIdentity = (provider: ProviderConfig) => {
		const identity = providerRequests.current.get(provider) ?? {};
		providerRequests.current.set(provider, identity);
		return identity;
	};

	/** Identify a model row independently of its position and non-ID field edits. */
	const modelIdentity = (model: ModelItem) => rowMetadata.current.get(model)?.identity ?? model;

	/** Carry provenance across field edits, not across a change of model identity. */
	const editModel = (model: ModelItem, fields: Partial<ModelItem>): ModelItem => {
		const next = { ...model, ...fields };
		const metadata = rowMetadata.current.get(model);
		// Parsed config can contain an incomplete row that the user is repairing.
		const identityChanged = typeof next.id === "string" && typeof model.id === "string"
			? next.id.trim() !== model.id.trim()
			: next.id !== model.id;
		if (identityChanged) {
			for (const field of metadata?.catalogFields ?? []) {
				if (!Object.hasOwn(fields, field)) delete next[field];
			}
		} else {
			rowMetadata.current.set(next, {
				identity: metadata?.identity ?? model,
				catalogFields: new Set([...(metadata?.catalogFields ?? [])].filter((field) => !Object.hasOwn(fields, field))),
			});
		}
		return next;
	};

	/** Keep transient suggestions on the copy, but never share its row identity. */
	const copyCatalogProvenance = (model: ModelItem, copy: ModelItem) => {
		const metadata = rowMetadata.current.get(model);
		if (metadata?.catalogFields.size) {
			rowMetadata.current.set(copy, { identity: copy, catalogFields: metadata.catalogFields });
		}
	};

	/** Register catalog patches so correcting the model ID can remove just the suggestions. */
	const withModelSpec = (model: ModelItem, spec: ModelSpec): ModelItem => {
		const patches = computeModelSpecPatches(model, spec);
		if (!patches.length) return model;
		const metadata = rowMetadata.current.get(model);
		const next = { ...model, ...Object.fromEntries(patches) };
		rowMetadata.current.set(next, {
			identity: metadata?.identity ?? model,
			catalogFields: new Set([...(metadata?.catalogFields ?? []), ...patches.map(([field]) => field)]),
		});
		return next;
	};

	/** Resolve fetched IDs, then append only IDs still missing from the originating provider. */
	const appendFetchedModels = async (
		providerName: string, candidates: ModelItem[], lookup: ModelSpecLookup, isCurrent: () => boolean,
	): Promise<number | null> => {
		const original = current.current.providers[providerName];
		if (!original || !candidates.length || !isCurrent()) return null;
		const identity = providerIdentity(original);
		const specs = await Promise.all(candidates.map((model) => lookup(providerName, model.id).catch(() => null)));
		const data = current.current;
		const provider = data.providers[providerName];
		if (!isCurrent() || !provider || providerRequests.current.get(provider) !== identity) return null;
		const ids = new Set(provider.models.map((model) => model.id));
		const added: ModelItem[] = [];
		let filledCount = 0;
		for (const [index, model] of candidates.entries()) {
			if (ids.has(model.id)) continue;
			ids.add(model.id);
			const spec = specs[index];
			const next = spec ? withModelSpec(model, spec) : model;
			if (next !== model) filledCount++;
			added.push(next);
		}
		if (!added.length) return null;
		const models = [...provider.models, ...added];
		setModelsData({ ...data, providers: { ...data.providers, [providerName]: { ...provider, models } } });
		return filledCount;
	};

	/** Apply the spec to the same row and ID, merging only fields still missing. */
	const fillModelSpec = (providerName: string, index: number, original: ModelItem, spec: ModelSpec): boolean => {
		const data = current.current;
		const provider = data.providers[providerName];
		const model = provider?.models[index];
		if (!model || modelIdentity(model) !== modelIdentity(original)) return false;
		const next = withModelSpec(model, spec);
		if (next === model) return false;
		const models = [...provider.models];
		models[index] = next;
		setModelsData({ ...data, providers: { ...data.providers, [providerName]: { ...provider, models } } });
		return true;
	};

	/** Capture just the row identity; the confirmation must edit the latest draft. */
	const prepareModelDeletion = (providerName: string, model: ModelItem) => {
		const identity = modelIdentity(model);
		return () => {
			const data = current.current;
			const provider = data.providers[providerName];
			const index = provider?.models.findIndex((row) => modelIdentity(row) === identity) ?? -1;
			if (!provider || index < 0) return false;
			const models = provider.models.filter((_, i) => i !== index);
			setModelsData({ ...data, providers: { ...data.providers, [providerName]: { ...provider, models } } });
			return true;
		};
	};

	/** Capture only the confirmed providers and keep changes to the rest of the draft. */
	const prepareProviderDeletion = (names: string[]) => {
		const targets = names.flatMap((name) => {
			const provider = current.current.providers[name];
			return provider ? [{ name, identity: providerIdentity(provider) }] : [];
		});
		return () => {
			const data = current.current;
			const providers = { ...data.providers };
			const removed = [];
			for (const { name, identity } of targets) {
				const provider = providers[name];
				if (!provider || providerRequests.current.get(provider) !== identity) continue;
				delete providers[name];
				removed.push(name);
			}
			if (removed.length) setModelsData({ ...data, providers });
			return removed;
		};
	};

	/** Persisted limits are no longer suggestions, even if the subsequent reload fails. */
	const markModelsPersisted = () => { rowMetadata.current = new WeakMap(); };

	return { modelsData, setModelsData, current, editModel, fillModelSpec, copyCatalogProvenance,
		appendFetchedModels, markModelsPersisted, prepareModelDeletion, prepareProviderDeletion };
}
