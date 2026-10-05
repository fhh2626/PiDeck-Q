import { useEffect, useRef, type ReactNode } from "react";

const CONTENT_GAP_PX = 8;

type ComposerMeasuredExtrasProps = {
  widgets: ReactNode;
  queuePanel?: ReactNode;
  deliveryNotice: ReactNode;
  attachmentBar: ReactNode;
  onHeightChange: (extraHeight: number) => void;
};

/**
 * 附件/widget 高度的独立 owner：子树独立更新也能回缩面板，不必等用户输入。
 * ResizeObserver 在真实尺寸变化后、绘制前报告高度，不因草稿 render 读布局。
 */
export function ComposerMeasuredExtras(props: ComposerMeasuredExtrasProps) {
  const widgetsRef = useRef<HTMLDivElement | null>(null);
  const attachmentBarRef = useRef<HTMLDivElement | null>(null);
  const lastContentExtraRef = useRef(0);
  const mountedRef = useRef(false);
  const onHeightChangeRef = useRef(props.onHeightChange);
  onHeightChangeRef.current = props.onHeightChange;

  const measureExtra = () => {
    const widgetsH = widgetsRef.current?.offsetHeight ?? 0;
    const imageBarH = attachmentBarRef.current?.offsetHeight ?? 0;
    // gap 实测：Tailwind gap-2 是 rem，随根字号变化；用 rowGap 拿到真实 px。
    let gapPx = CONTENT_GAP_PX;
    const footerEl = widgetsRef.current?.parentElement;
    if (footerEl && typeof window !== "undefined") {
      const rowGap = parseFloat(window.getComputedStyle(footerEl).rowGap || "");
      if (!Number.isNaN(rowGap) && rowGap > 0) gapPx = rowGap;
    }
    return Math.ceil(widgetsH + imageBarH + (imageBarH > 0 ? gapPx : 0));
  };

  const reportExtra = () => {
    const extra = measureExtra();
    if (extra === lastContentExtraRef.current) return;
    lastContentExtraRef.current = extra;
    onHeightChangeRef.current(extra);
  };

  const hasAttachmentBar = props.attachmentBar != null;
  useEffect(() => {
    // 首测仍在面板注册后的下一帧；后续 observer 在 paint 前报告实际高度变化，
    // 不为每次草稿 render 同步测量，也不额外延迟一帧导致附件挤压输入区。
    mountedRef.current = false;
    const rafId = requestAnimationFrame(() => {
      mountedRef.current = true;
      reportExtra();
    });
    const observer = new ResizeObserver(() => {
      if (mountedRef.current) reportExtra();
    });
    if (widgetsRef.current) observer.observe(widgetsRef.current);
    if (attachmentBarRef.current) observer.observe(attachmentBarRef.current);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [hasAttachmentBar]);

  return (
    <>
      <div
        ref={widgetsRef}
        className="flex shrink-0 min-h-0 min-w-0 flex-col gap-2 empty:hidden"
      >
        {props.widgets}
        {props.queuePanel}
        {props.deliveryNotice}
      </div>
      {hasAttachmentBar ? (
        <div ref={attachmentBarRef} className="shrink-0">
          {props.attachmentBar}
        </div>
      ) : null}
    </>
  );
}
