import { useEffect } from "react";
import type { PiDesktopApi } from "../../../shared/desktop/createPiDesktopApi";
import { isNativeRuntime } from "../desktopApi";
import { t } from "../i18n";

type NativeFileDropDetail = {
	paths: string[];
	externalFileCapabilityId: string;
	clientX?: number;
	clientY?: number;
};

type NativeFileDropCopyInput = {
	api: Pick<PiDesktopApi, "files">;
	refreshFiles: () => void | Promise<unknown>;
	showToast: (message: string, duration?: number) => void;
};

function isNativeFileDropDetail(value: unknown): value is NativeFileDropDetail {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (!("paths" in value) || !Array.isArray(value.paths) || value.paths.some((path) => typeof path !== "string")) return false;
	if (!("externalFileCapabilityId" in value) || typeof value.externalFileCapabilityId !== "string" || value.externalFileCapabilityId.length === 0) return false;
	if ("clientX" in value && value.clientX !== undefined && typeof value.clientX !== "number") return false;
	if ("clientY" in value && value.clientY !== undefined && typeof value.clientY !== "number") return false;
	return value.paths.length > 0;
}

function readNativeFileDropDetail(event: Event): NativeFileDropDetail | null {
	if (!(event instanceof CustomEvent)) return null;
	return isNativeFileDropDetail(event.detail) ? event.detail : null;
}

/** Copies a trusted Qt OS drop into the file drawer without accepting renderer paths as authority. */
export function useNativeFileDropCopy({ api, refreshFiles, showToast }: NativeFileDropCopyInput): void {
	useEffect(() => {
		if (!isNativeRuntime) return;
		const handleNativeFileDrop = (event: Event) => {
			const detail = readNativeFileDropDetail(event);
			if (!detail) return;
			const point = typeof detail.clientX === "number" && typeof detail.clientY === "number"
				? document.elementFromPoint(detail.clientX, detail.clientY)
				: null;
			const target = point?.closest<HTMLElement>("[data-native-file-drop-target]");
			const panel = point?.closest<HTMLElement>("[data-native-file-drop-root]");
			if (!panel) return;
			const targetDir = target?.dataset.nativeFileDropTarget ?? panel.dataset.nativeFileDropRoot;
			if (!targetDir) return;
			void api.files.copyExternal(detail.externalFileCapabilityId, targetDir).then(() => {
				void refreshFiles();
				showToast(t("app.fileCopyDone", { count: detail.paths.length }), 2000);
			}).catch((error: unknown) => {
				showToast(t("app.filePasteFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
			});
		};
		window.addEventListener("pideck-native-file-drop", handleNativeFileDrop);
		return () => window.removeEventListener("pideck-native-file-drop", handleNativeFileDrop);
	}, [api, refreshFiles, showToast]);
}
