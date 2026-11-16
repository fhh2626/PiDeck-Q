import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "jotai";
import { enqueueFileEditorSaveAtom, fileEditorSaveQueuesAtom } from "../atoms/file-editor-saves";

/** Own one loaded document's edits and saves, fenced from later reads or unmount. */
export function useFileEditorBuffer(input: {
	filePath: string;
	saveContent?: (path: string, content: string) => Promise<void>;
	onError: (error: string | null) => void;
}) {
	const { filePath, saveContent, onError } = input;
	const store = useStore();
	const [content, setContent] = useState("");
	const [dirty, setDirty] = useState(false);
	const contentRef = useRef(content);
	// The current document owns its UI baseline. Queue ordering and successful
	// disk baselines belong to the store and survive this viewer's unmount.
	const lastSavedRef = useRef({ content: "", trusted: true });
	const readHadPendingSaveRef = useRef(false);
	const readyRef = useRef(false);
	const generationRef = useRef(0);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const cancelAutoSave = useCallback(() => {
		if (saveTimerRef.current !== null) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
	}, []);

	/** Fence UI updates and cancel unsent autosaves before loading another document. */
	const beginRead = useCallback(() => {
		const generation = ++generationRef.current;
		readHadPendingSaveRef.current = store.get(fileEditorSaveQueuesAtom).has(filePath);
		readyRef.current = false;
		cancelAutoSave();
		setDirty(false);
		return () => {
			if (generationRef.current !== generation) return;
			generationRef.current += 1;
			readyRef.current = false;
			cancelAutoSave();
		};
	}, [cancelAutoSave, filePath, store]);

	/** A successful guarded read establishes the baseline without scheduling a write. */
	const setLoadedContent = useCallback((result: string) => {
		contentRef.current = result;
		lastSavedRef.current = {
			content: result,
			trusted: !readHadPendingSaveRef.current && !store.get(fileEditorSaveQueuesAtom).has(filePath),
		};
		readyRef.current = true;
		setContent(result);
		setDirty(false);
	}, [filePath, store]);

	const saveNow = useCallback(async () => {
		cancelAutoSave();
		if (!saveContent || !readyRef.current) return;
		const latest = contentRef.current;
		const generation = generationRef.current;
		const savedDocument = lastSavedRef.current;
		onError(null);
		try {
			// Submit every accepted snapshot now. Waiting in a viewer-local queue would
			// let a reopened editor submit its newer snapshot ahead of this one.
			await store.set(enqueueFileEditorSaveAtom, {
				filePath, content: latest, saveContent,
				readBaseline: savedDocument.trusted ? savedDocument.content : undefined,
			});
			savedDocument.content = latest;
			savedDocument.trusted = true;
			if (generationRef.current !== generation) return;
			// The write acknowledges its snapshot, never replaces newer typed text.
			onError(null);
			setDirty(contentRef.current !== latest);
		} catch (error) {
			savedDocument.trusted = false;
			if (generationRef.current === generation) {
				onError(error instanceof Error ? error.message : String(error));
			}
		}
	}, [cancelAutoSave, filePath, onError, saveContent, store]);

	const scheduleAutoSave = useCallback(() => {
		if (!saveContent) return;
		cancelAutoSave();
		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = null;
			void saveNow();
		}, 500);
	}, [cancelAutoSave, saveContent, saveNow]);

	const handleEditorChange = useCallback((value: string) => {
		// Update the snapshot in the input callback, before React's next render.
		contentRef.current = value;
		setContent(value);
		setDirty(value !== lastSavedRef.current.content);
		scheduleAutoSave();
	}, [scheduleAutoSave]);

	useEffect(() => () => {
		generationRef.current += 1;
		readyRef.current = false;
		cancelAutoSave();
	}, [cancelAutoSave]);

	return { content, dirty, beginRead, setLoadedContent, handleEditorChange, saveNow };
}
