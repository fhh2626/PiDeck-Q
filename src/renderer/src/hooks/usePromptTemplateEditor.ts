import { useCallback, useEffect, useRef, useState } from "react";
import type { PiPromptTemplateSummary } from "../../../shared/types";
import { t } from "../i18n";

/** Storage is supplied by the global/project owner; the editor never writes files itself. */
export type PromptEditorStorage = {
	read: (template: PiPromptTemplateSummary) => Promise<string>;
	write: (template: PiPromptTemplateSummary, content: string) => Promise<void>;
	/** The returned content is the actual persisted baseline of the new user file. */
	createCopy?: (template: PiPromptTemplateSummary) => Promise<PiPromptTemplateSummary>;
};

type EditorState = {
	template: PiPromptTemplateSummary | null;
	content: string;
	savedContent: string;
	loading: boolean;
	ready: boolean;
	saving: boolean;
	saved: boolean;
	error: string | null;
};
type Options = {
	storage: PromptEditorStorage;
	onSaved?: () => Promise<void>;
	onDirtyChange?: (dirty: boolean) => void;
};

/** A successful read/save establishes the baseline; failed writes never clear the draft. */
function initialState(): EditorState {
	return { template: null, content: "", savedContent: "", loading: false, ready: false, saving: false, saved: false, error: null };
}
function isDirty(state: EditorState): boolean {
	return state.ready && state.content !== state.savedContent;
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Owns one prompt editor, including baseline, busy locks, errors and async identity guards. */
export function usePromptTemplateEditor(options: Options) {
	const [state, setState] = useState(initialState);
	const stateRef = useRef(state);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const generation = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; generation.current++; };
	}, []);

	// Update the synchronous command snapshot before React commits. Double shortcuts
	// in the same frame must see saving=true rather than start two writes.
	const commit = useCallback((next: EditorState) => {
		if (!mounted.current) return;
		stateRef.current = next;
		setState(next);
		optionsRef.current.onDirtyChange?.(isDirty(next));
	}, []);

	const open = useCallback(async (template: PiPromptTemplateSummary): Promise<boolean> => {
		if (!mounted.current || stateRef.current.saving) return false;
		const request = ++generation.current;
		const storage = optionsRef.current.storage;
		commit({ ...initialState(), template, loading: true });
		try {
			const content = await storage.read(template);
			if (!mounted.current || request !== generation.current) return false;
			commit({ ...stateRef.current, content, savedContent: content, loading: false, ready: true });
			return true;
		} catch (error) {
			if (mounted.current && request === generation.current) {
				commit({ ...stateRef.current, loading: false, error: t("config.promptEditorReadFailed", { message: errorMessage(error) }) });
			}
			return false;
		}
	}, [commit]);

	const change = useCallback((content: string) => {
		const current = stateRef.current;
		if (!current.template || !current.ready || current.saving) return;
		commit({ ...current, content, saved: false, error: null });
	}, [commit]);

	const close = useCallback((): boolean => {
		if (stateRef.current.saving) return false;
		generation.current++;
		commit(initialState());
		return true;
	}, [commit]);

	const save = useCallback(async (): Promise<boolean> => {
		const snapshot = stateRef.current;
		if (!mounted.current || !snapshot.template || snapshot.loading || snapshot.saving || !isDirty(snapshot)) return false;
		const request = generation.current;
		const { storage, onSaved } = optionsRef.current;
		const active = () => mounted.current && request === generation.current;
		commit({ ...snapshot, saving: true, saved: false, error: null });
		try {
			let target = snapshot.template;
			if (!target.userCreated && storage.createCopy) {
				target = await storage.createCopy(target);
				if (!active()) return false;
				// Creation persists only frontmatter, not the builtin body. Move both
				// identity and baseline to this file so a failed write followed by undo
				// remains dirty until the body is actually saved. Retrying reuses the path.
				commit({ ...stateRef.current, template: target, savedContent: target.content });
			}
			await storage.write(target, snapshot.content);
			if (!active()) return false;
			commit({ ...stateRef.current, savedContent: snapshot.content, saved: true });
			try {
				await onSaved?.();
			} catch (error) {
				// The file is already saved: a list-refresh failure is not a failed write.
				if (active()) commit({ ...stateRef.current, error: t("config.promptEditorRefreshFailed", { message: errorMessage(error) }) });
			}
			return true;
		} catch (error) {
			if (active()) commit({ ...stateRef.current, error: t("config.promptEditorSaveFailed", { message: errorMessage(error) }) });
			return false;
		} finally {
			if (active()) commit({ ...stateRef.current, saving: false });
		}
	}, [commit]);

	return { state, dirty: isDirty(state), open, change, close, save };
}
export type PromptTemplateEditor = ReturnType<typeof usePromptTemplateEditor>;
