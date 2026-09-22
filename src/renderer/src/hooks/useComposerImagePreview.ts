import { useCallback, useState } from "react";
import type { ImageContent } from "../../../shared/types";

type Preview = { image: ImageContent; images?: ImageContent[] } | null;
export type PreviewMessageImage = (image: ImageContent | null, images?: ImageContent[]) => void;

/** Desktop delegates to the shared owner; standalone/Web composers retain local preview. */
export function useComposerImagePreview(onPreviewImage?: PreviewMessageImage) {
	const [localPreview, setLocalPreview] = useState<Preview>(null);
	const preview = useCallback((image: ImageContent | null, images?: ImageContent[]) => {
		if (onPreviewImage) {
			setLocalPreview(null);
			onPreviewImage(image, images);
		} else {
			setLocalPreview(image ? { image, images } : null);
		}
	}, [onPreviewImage]);
	const setPreviewImage = useCallback((value: Preview) => preview(value?.image ?? null, value?.images), [preview]);
	const closePreview = useCallback(() => preview(null), [preview]);
	return { previewImage: onPreviewImage ? null : localPreview, preview, setPreviewImage, closePreview };
}
