import type { ChatMessage, ImageContent } from "../../../../../shared/types";
import { MessageImageGallery } from "../MessageImageGallery";

export type AssistantMessageImagesProps = {
	assistantMessages: Array<{ message: ChatMessage }>;
	onPreviewImage?: (image: ImageContent) => void;
};

export function AssistantMessageImages({
	assistantMessages,
	onPreviewImage,
}: AssistantMessageImagesProps) {
	const messagesWithMedia = assistantMessages.filter(
		(item) =>
			(item.message.images && item.message.images.length > 0) ||
			Boolean(item.message.imageDisplayNotice),
	);

	if (messagesWithMedia.length === 0) return null;

	return (
		<div className="flex flex-col gap-2">
			{messagesWithMedia.map((item) => (
				<div key={item.message.id} data-assistant-media={item.message.id}>
					<MessageImageGallery
						images={item.message.images}
						notice={item.message.imageDisplayNotice}
						onPreviewImage={onPreviewImage}
					/>
				</div>
			))}
		</div>
	);
}
