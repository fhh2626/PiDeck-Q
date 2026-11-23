/** Minimal filesystem metadata for authorized local links, without reading their contents. */
export type FilePathInfo = {
	type: "file" | "directory" | "other";
};
