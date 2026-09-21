import { useState } from "react";
import { Info } from "lucide-react";
import type { ImageContent, ImageDisplayNotice } from "../../../../shared/types";
import { MessageImage, ImagePreviewModal } from "./MessageImage";
import { t } from "../../i18n";

export type MessageImageGalleryProps = {
	images?: ImageContent[];
	notice?: ImageDisplayNotice;
	className?: string;
	/** 第二参携带本组完整图片数组，供父级预览弹层做组内导航 */
	onPreviewImage?: (image: ImageContent, images?: ImageContent[]) => void;
};

export function MessageImageGallery(props: MessageImageGalleryProps) {
	const [selectedImage, setSelectedImage] = useState<ImageContent | null>(null);

	const noticeText = (() => {
		if (!props.notice) return null;
		switch (props.notice.kind) {
			case "too-large":
				return t("tool.images.notice.tooLarge");
			case "too-many":
				return t("tool.images.notice.tooMany", {
					count: props.notice.count ?? 8,
					omitted: props.notice.omitted ?? 0,
				});
			case "runtime-budget-exceeded":
				return t("tool.images.notice.runtimeBudget");
			case "delivery-budget-exceeded":
				return t("tool.images.notice.deliveryBudget");
			default:
				return null;
		}
	})();

	const hasImages = Boolean(props.images && props.images.length > 0);
	if (!hasImages && !noticeText) return null;

	return (
		<div className={`message-image-gallery flex flex-col gap-1.5 my-2 ${props.className ?? ""}`}>
			{hasImages && (
				<div className="flex flex-wrap items-center gap-2">
					{props.images?.map((image, index) => (
						<div
							key={index}
							role="button"
							tabIndex={0}
							className="relative group cursor-pointer overflow-hidden rounded-md border border-border/50 bg-muted/20 hover:border-border focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none transition-colors max-h-48 max-w-xs"
							onClick={() => {
								if (props.onPreviewImage) {
									props.onPreviewImage(image, props.images);
								} else {
									setSelectedImage(image);
								}
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									if (props.onPreviewImage) {
										props.onPreviewImage(image, props.images);
									} else {
										setSelectedImage(image);
									}
								}
							}}
							aria-label={t("common.preview")}
						>
							<MessageImage
								src={`data:${image.mimeType};base64,${image.data}`}
								alt={t("app.imagePreviewAlt")}
								className="max-h-48 max-w-xs object-contain"
							/>
						</div>
					))}
				</div>
			)}
			{noticeText && (
				<div className="flex items-center gap-1.5 text-micro text-muted-foreground italic px-1 py-0.5">
					<Info size={12} className="shrink-0 text-muted-foreground/80" aria-hidden="true" />
					<span>{noticeText}</span>
				</div>
			)}
			{selectedImage && (
				<ImagePreviewModal
					image={selectedImage}
					images={props.images}
					onClose={() => setSelectedImage(null)}
				/>
			)}
		</div>
	);
}
