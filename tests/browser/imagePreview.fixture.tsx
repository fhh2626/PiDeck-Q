import React, { useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { MessageImageGallery } from "@/components/session/MessageImageGallery";
import { ImagePreviewModal } from "@/components/session/MessageImage";
import type { ImageContent } from "@shared/types";
import { useImagePreviewController } from "@/hooks/useImagePreviewController";
import { useComposerImagePreview } from "@/hooks/useComposerImagePreview";

// 构造三张互不相同且可有效解码的 PNG 图片 (data URL)
const redPngBase64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const greenPngBase64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const bluePngBase64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwGAX6T/owAAAABJRU5ErkJggg==";

const testImages: ImageContent[] = [
	{ type: "image", mimeType: "image/png", data: redPngBase64 },
	{ type: "image", mimeType: "image/png", data: greenPngBase64 },
	{ type: "image", mimeType: "image/png", data: bluePngBase64 },
];

// Equal prefix and length; only the closing tag is corrupted in the first SVG.
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>';
const collisionImages: ImageContent[] = [
	{ type: "image", mimeType: "image/svg+xml", data: btoa(svg.replace('</svg>', '</bad>')) },
	{ type: "image", mimeType: "image/svg+xml", data: btoa(svg) },
];

function TestApp() {
	const finishRead = useRef<((data: string) => void) | null>(null);
	const preview = useImagePreviewController({
		readBase64: () => new Promise((resolve) => { finishRead.current = resolve; }),
		openFile: async () => {},
		showToast: () => {},
	});
	const composer = useComposerImagePreview(preview.openMessageImage);
	const [galleryList, setGalleryList] = useState<ImageContent[]>(testImages);
	const [showGallery, setShowGallery] = useState(true);

	return (
		<div className="p-8 space-y-6">
			<h1 className="text-xl font-bold">Image Preview Test Fixture</h1>
			<button id="collision-preview" onClick={() => preview.openMessageImage(collisionImages[0], collisionImages)}>Decode collision</button>
			<button id="local-read" onClick={() => preview.openLocalImage("C:/slow.png")}>Start local read</button>
			<button id="resolve-read" onClick={() => finishRead.current?.(redPngBase64)}>Finish local read</button>
			<button id="composer-preview" onClick={() => composer.preview(testImages[1], testImages)}>Composer attachment</button>

			<div className="space-y-4 border p-4 rounded-md">
				<div className="flex gap-4 items-center">
					<button
						id="focus-target-btn"
						type="button"
						className="px-4 py-2 bg-secondary rounded text-sm"
					>
						Outside Button
					</button>

					<button
						id="remove-trigger-btn"
						type="button"
						className="px-4 py-2 bg-destructive text-destructive-foreground rounded text-sm"
						onClick={() => setShowGallery(false)}
					>
						Remove Gallery
					</button>

					<button
						id="set-single-btn"
						type="button"
						className="px-4 py-2 bg-accent rounded text-sm"
						onClick={() => setGalleryList([testImages[0]])}
					>
						Set Single Image
					</button>
				</div>

				{showGallery && (
					<div id="gallery-container">
						<MessageImageGallery
							images={galleryList}
							onPreviewImage={preview.openMessageImage}
						/>
					</div>
				)}
			</div>

			{preview.previewImage && (
				<ImagePreviewModal
					image={preview.previewImage.image}
					images={preview.previewImage.images}
					localSourcePath={preview.previewImage.localSourcePath}
					onOpenInSystem={preview.openInSystem}
					onClose={preview.closePreview}
				/>
			)}
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(<TestApp />);
}
