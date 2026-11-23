import { atom } from "jotai";

/** Active write tails belong to the store, so a reopened viewer joins the same file's queue. */
export const fileEditorSaveQueuesAtom = atom<ReadonlyMap<string, Promise<string | undefined>>>(new Map());

type FileEditorSaveRequest = {
	filePath: string;
	content: string;
	/** A read that overlapped an accepted write cannot establish a trustworthy disk baseline. */
	readBaseline: string | undefined;
	saveContent: (path: string, content: string) => Promise<void>;
};

/** Accept immediately, serialize one path, and release its saved content when the tail finishes. */
export const enqueueFileEditorSaveAtom = atom(null, (get, set, input: FileEditorSaveRequest): Promise<void> => {
	const queues = get(fileEditorSaveQueuesAtom);
	const previous = queues.get(input.filePath) ?? Promise.resolve(input.readBaseline);
	const write = previous.then(async (previousContent) => {
		// Once another viewer has queued a write, its successful content is the
		// baseline. This viewer's earlier read may no longer describe the disk.
		if (input.content !== previousContent) await input.saveContent(input.filePath, input.content);
		return input.content;
	});
	// A failed write leaves the disk baseline unknown and never blocks a later save.
	const tail = write.catch(() => undefined);
	set(fileEditorSaveQueuesAtom, new Map(queues).set(input.filePath, tail));
	void tail.then(() => {
		const current = get(fileEditorSaveQueuesAtom);
		if (current.get(input.filePath) !== tail) return;
		const remaining = new Map(current);
		remaining.delete(input.filePath);
		set(fileEditorSaveQueuesAtom, remaining);
	});
	return write.then(() => undefined);
});
