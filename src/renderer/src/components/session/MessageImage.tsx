import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react";
import type { ImageContent } from "../../../../shared/types";
import { t } from "../../i18n";
import { Dialog, DialogContent } from "../ui-shadcn/dialog";

function ImageLoader(props: {
	src: string;
	alt: string;
	className: string;
	onClick?: () => void;
	placeholderClass?: string;
}) {
	const ref = useRef<HTMLImageElement>(null);
	const [inView, setInView] = useState(false);
	const [hasError, setHasError] = useState(false);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					setInView(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "200px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	if (hasError) {
		return (
			<div
				className={`flex items-center justify-center gap-1.5 p-3 text-caption text-muted-foreground bg-muted/40 rounded ${props.className}`}
				role="alert"
			>
				<ImageOff size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
				<span>{t("composer.images.decodeFailed")}</span>
			</div>
		);
	}

	return (
		<img
			ref={ref}
			src={inView ? props.src : undefined}
			alt={props.alt}
			className={`${props.className}${!inView && props.placeholderClass ? ` ${props.placeholderClass}` : ""}`}
			loading="lazy"
			decoding="async"
			onClick={props.onClick}
			onError={() => setHasError(true)}
		/>
	);
}

/** 会话图片按视口懒解码，并在 src 变化时通过 key 重置解码错误状态。 */
export function MessageImage(props: {
	src: string;
	alt: string;
	className: string;
	onClick?: () => void;
	placeholderClass?: string;
}) {
	return <ImageLoader key={props.src} {...props} />;
}

export type ImagePreviewModalProps = {
	image: ImageContent;
	images?: ImageContent[];
	onClose: () => void;
	onSelectImage?: (image: ImageContent) => void;
};

/** 全屏图片预览层，基于共享 Dialog 原语重构，支持焦点管理与键盘左右导航。 */
export function ImagePreviewModal(props: ImagePreviewModalProps) {
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);

	const allImages = useMemo(
		() => (props.images && props.images.length > 0 ? props.images : [props.image]),
		[props.images, props.image],
	);
	const [currentIndex, setCurrentIndex] = useState(() => {
		const idx = allImages.findIndex((img) => img === props.image || img.data === props.image.data);
		return idx >= 0 ? idx : 0;
	});

	// 若 props.image 发生变化，同步更新 currentIndex
	useEffect(() => {
		const idx = allImages.findIndex((img) => img === props.image || img.data === props.image.data);
		if (idx >= 0) setCurrentIndex(idx);
	}, [props.image, allImages]);

	const currentImage = allImages[currentIndex] ?? props.image;
	const hasMultiple = allImages.length > 1;

	const handlePrev = useCallback(() => {
		setCurrentIndex((prev) => (prev > 0 ? prev - 1 : allImages.length - 1));
	}, [allImages.length]);

	const handleNext = useCallback(() => {
		setCurrentIndex((prev) => (prev < allImages.length - 1 ? prev + 1 : 0));
	}, [allImages.length]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				handlePrev();
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				handleNext();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handlePrev, handleNext]);

	return (
		<Dialog open={true} onOpenChange={(open) => !open && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				// 覆盖共享 DialogContent 基类的定位（translate-50% / sm:max-w-lg）：
				// 全屏预览必须铺满视口，不能被居中平移半个自身或限宽。
				// 不传 z-50，继承共享原语的 z-(--z-dialog)（950），确保内容与按钮位于 overlay 上方。
				className="fixed inset-0 top-0 right-0 bottom-0 left-0 flex flex-col items-center justify-center border-none bg-transparent p-4 shadow-none translate-x-0 translate-y-0 max-w-none sm:max-w-none w-screen h-screen focus:outline-none"
				onClick={(event) => {
					// 点击 content 空白区域关闭；点击图片及按钮等子元素不触发关闭
					if (event.target === event.currentTarget) {
						props.onClose();
					}
				}}
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					const active = document.activeElement;
					returnFocusRef.current = active instanceof HTMLElement ? active : null;
					closeButtonRef.current?.focus({ preventScroll: true });
				}}
				onCloseAutoFocus={(e) => {
					// 阻止 Radix trigger-only 的默认行为；若打开前目标仍挂载，显式恢复焦点
					e.preventDefault();
					const target = returnFocusRef.current;
					if (target?.isConnected) {
						target.focus({ preventScroll: true });
					}
				}}
			>
				<button
					ref={closeButtonRef}
					type="button"
					data-testid="preview-close-btn"
					className="absolute top-4 right-4 z-50 flex items-center justify-center size-9 rounded-full bg-black/60 text-white/80 hover:text-white hover:bg-black/90 transition-colors focus:outline-none focus:ring-2 focus:ring-white"
					onClick={props.onClose}
					aria-label={t("app.imagePreviewClose")}
				>
					<X size={20} strokeWidth={2.4} />
				</button>

				{hasMultiple && (
					<>
						<button
							type="button"
							data-testid="preview-prev-btn"
							className="absolute left-4 top-1/2 -translate-y-1/2 z-50 flex items-center justify-center size-10 rounded-full bg-black/60 text-white/80 hover:text-white hover:bg-black/90 transition-colors focus:outline-none focus:ring-2 focus:ring-white"
							onClick={(e) => {
								e.stopPropagation();
								handlePrev();
							}}
							aria-label={t("app.imagePreviewPrevious")}
						>
							<ChevronLeft size={24} />
						</button>
						<button
							type="button"
							data-testid="preview-next-btn"
							className="absolute right-4 top-1/2 -translate-y-1/2 z-50 flex items-center justify-center size-10 rounded-full bg-black/60 text-white/80 hover:text-white hover:bg-black/90 transition-colors focus:outline-none focus:ring-2 focus:ring-white"
							onClick={(e) => {
								e.stopPropagation();
								handleNext();
							}}
							aria-label={t("app.imagePreviewNext")}
						>
							<ChevronRight size={24} />
						</button>
					</>
				)}

				<div
					className="relative flex items-center justify-center max-w-full max-h-full overflow-hidden"
					onClick={(e) => e.stopPropagation()}
				>
					{hasMultiple ? (
						<img
							src={`data:${currentImage.mimeType};base64,${currentImage.data}`}
							alt={t("app.imagePreviewAlt")}
							className="max-w-[90vw] max-h-[85vh] object-contain select-none rounded-sm shadow-2xl"
						/>
					) : (
						<img
							src={`data:${props.image.mimeType};base64,${props.image.data}`}
							alt={t("app.imagePreviewAlt")}
							className="max-w-[90vw] max-h-[85vh] object-contain select-none rounded-sm shadow-2xl"
						/>
					)}
				</div>

				{hasMultiple && (
					<div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/60 text-xs font-mono text-white/80">
						{currentIndex + 1} / {allImages.length}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
