import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageContent } from "../../../shared/types";
import { resolveFileLinkPath } from "../utils/fileLinks";
import { t } from "../i18n";

export const IMAGE_EXTENSIONS = new Set([
	"jpg",
	"jpeg",
	"png",
	"gif",
	"webp",
	"svg",
	"bmp",
	"ico",
	"avif",
]);

export function getMimeTypeFromExtension(ext: string): string {
	switch (ext.toLowerCase()) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		case "svg":
			return "image/svg+xml";
		case "bmp":
			return "image/bmp";
		case "ico":
			return "image/x-icon";
		case "avif":
			return "image/avif";
		default:
			return "image/png";
	}
}

export type PreviewImageState = {
	image: ImageContent;
	images?: ImageContent[];
	localSourcePath?: string;
} | null;

export interface UseImagePreviewControllerOptions {
	readBase64: (path: string, maxBytes?: number) => Promise<string>;
	openFile: (path: string) => Promise<void>;
	showToast: (message: string, duration?: number) => void;
	log?: (level: "info" | "warn" | "error", scope: string, message: string, detail?: Record<string, unknown>) => void | Promise<void>;
}

/** Owns the single desktop preview and invalidates all superseded reads. */
export function useImagePreviewController(options: UseImagePreviewControllerOptions) {
	const [previewImage, setPreviewImage] = useState<PreviewImageState>(null);
	const requestIdRef = useRef(0);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	// Diagnostics are best-effort: a disconnected log IPC cannot hide the toast.
	const log = useCallback((level: "warn" | "error", message: string, detail: Record<string, unknown>) => {
		try {
			void Promise.resolve(optionsRef.current.log?.(level, "image-preview", message, detail)).catch(() => undefined);
		} catch { /* Synchronous adapters can fail too; logging must never own user feedback. */ }
	}, []);

	// 卸载时使未决请求失效，防止向已销毁页面提交状态
	useEffect(() => {
		return () => {
			requestIdRef.current++;
		};
	}, []);

	const openLocalImage = useCallback(
		(path: string, basePath?: string) => {
			const resolved = resolveFileLinkPath(path, basePath);
			const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
			if (!IMAGE_EXTENSIONS.has(ext)) {
				return false;
			}

			const reqId = ++requestIdRef.current;
			const mimeType = getMimeTypeFromExtension(ext);

			void Promise.resolve()
				.then(() => optionsRef.current.readBase64(resolved, 10 * 1024 * 1024))
				.then((raw) => {
					if (reqId !== requestIdRef.current) return;
					if (typeof raw !== "string") {
						optionsRef.current.showToast(t("app.imageReadFormatError"));
						log("error", "Image read returned non-string format", { path: resolved });
						return;
					}
					if (!raw) {
						optionsRef.current.showToast(t("app.imageNotFoundOrEmpty"));
						log("warn", "Image file is empty or not found", { path: resolved });
						return;
					}

					setPreviewImage({
						image: { type: "image", mimeType, data: raw },
						localSourcePath: resolved,
					});
				})
				.catch((err) => {
					if (reqId !== requestIdRef.current) return;
					const message = err instanceof Error ? err.message : String(err);
					log("error", "Image read failed", { path: resolved, error: message });

					if (message.includes("FILE_TOO_LARGE") || message.includes("exceed")) {
						optionsRef.current.showToast(t("app.imageTooLarge"));
					} else if (
						message.includes("FILE_PATH_NOT_AUTHORIZED") ||
						message.includes("not authorized") ||
						message.includes("EACCES") ||
						message.includes("EPERM") ||
						message.includes("permission")
					) {
						optionsRef.current.showToast(t("app.imagePermissionDenied"));
					} else if (
						message.includes("ENOENT") ||
						message.includes("not found") ||
						message.includes("no such file")
					) {
						optionsRef.current.showToast(t("app.imageNotFoundOrEmpty"));
					} else {
						optionsRef.current.showToast(t("app.imageReadFailed"));
					}
				});

			return true;
		},
		[log],
	);

	const openMessageImage = useCallback((image: ImageContent | null, images?: ImageContent[]) => {
		requestIdRef.current++;
		setPreviewImage(image ? { image, images } : null);
	}, []);

	const closePreview = useCallback(() => {
		requestIdRef.current++;
		setPreviewImage(null);
	}, []);

	const openInSystem = useCallback(
		async (localPath: string) => {
			try {
				await optionsRef.current.openFile(localPath);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log("error", "Open in system application failed", { path: localPath, error: message });
				throw err;
			}
		},
		[log],
	);

	return {
		previewImage,
		openLocalImage,
		openMessageImage,
		closePreview,
		openInSystem,
	};
}
