import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { MessageImageGallery } from "@/components/session/MessageImageGallery";
import { ImagePreviewModal } from "@/components/session/MessageImage";
import type { ImageContent } from "@shared/imageContent";

// 构造三张互不相同且可有效解码的 PNG 图片 (data URL)
const redPngBase64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const greenPngBase64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const bluePngBase64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwGAX6T/owAAAABJRU5ErkJggg==";

const testImages: ImageContent[] = [
	{ mimeType: "image/png", data: redPngBase64 },
	{ mimeType: "image/png", data: greenPngBase64 },
	{ mimeType: "image/png", data: bluePngBase64 },
];

function TestApp() {
	const [activeImage, setActiveImage] = useState<ImageContent | null>(null);
	const [galleryList, setGalleryList] = useState<ImageContent[]>(testImages);
	const [showGallery, setShowGallery] = useState(true);

	return (
		<div className="p-8 space-y-6">
			<h1 className="text-xl font-bold">Image Preview Test Fixture</h1>

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
							onPreviewImage={(img, imgs) => {
								setActiveImage(img);
							}}
						/>
					</div>
				)}
			</div>

			{activeImage && (
				<ImagePreviewModal
					image={activeImage}
					images={galleryList}
					onClose={() => setActiveImage(null)}
				/>
			)}
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(<TestApp />);
}
