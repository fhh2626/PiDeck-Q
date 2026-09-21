export type PickImagesResult =
	| { kind: "cancelled" }
	| { kind: "selected"; capabilityId: string; paths: string[] }
	| { kind: "error"; code: "TOO_MANY_FILES" | "PICKER_FAILED" };
