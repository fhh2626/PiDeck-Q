import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import {
  ComposerBottomBar,
  ImagePreviewModal,
  PromptSuggestions,
} from "./ComposerParts";
import {
  TipTapComposer,
} from "./composer";
import { SessionReferenceModal } from "../app/SessionReferenceModal";
import { t } from "../../i18n";
import { useSessionComposerController } from "../../hooks/useSessionComposerController";
import {
  ComposerAttachmentBar,
  ComposerSendControls,
  SessionDeliveryNotice,
} from "./ComposerPanels";
import { ComposerPickerHost } from "./ComposerPickerHost";
import { SecurityLevelMenu } from "./SecurityLevelMenu";
import { useAskPanel } from "../../hooks/useAskPanel";
import { modelPendingByIdAtom, setSessionDraftAtom, thinkingLevelPendingByIdAtom } from "../../atoms/composer-atoms";
import { sessionRecordByIdAtomFamily } from "../../atoms";
import { useSessionPaneActions } from "./SessionPaneServices";
import { desktopApi } from "../../desktopApi";
import { COMPOSER_DEFAULT_HEIGHT } from "../../rendererUtils";
import { chatContentWidthStyle } from "./chatContentWidth";
import type { GitBranchInfo } from "../../../../shared/types";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";

export type ComposerAreaProps = {
  sessionId: string;
  gitInfo?: GitBranchInfo;
  /** 输入框上方常驻扩展条（如 todo 条）；放在 widgets 槽位，高度由
   *  ComposerMeasuredExtras 测量并驱动面板自适应（同一测量链路）。 */
  widgets?: ReactNode;
  queuePanel?: ReactNode;
  onOpenFile?: (path: string) => void;
  /** 受控高度（px）。传入时由外层面板（react-resizable-panels）持有尺寸，
   *  本地 state 仅作非受控回退（#115 U5 布局换装）。 */
  height?: number;
  /** 非受控模式的起步高度（px），默认 COMPOSER_DEFAULT_HEIGHT；
   *  起始页等需要大输入框的场景传更高值，内容增高时仍自适应。 */
  defaultHeight?: number;
  onHeightChange?: (height: number) => void;
  /** 输入区上方可变内容（附件栏 / 扩展 widget / 队列 / 投递通知）当前占用的额外高度（px）。
   *  内容出现时上报给外层，由外层命令式增高 composer 面板，避免固定高度挤压输入区。 */
  onContentHeightChange?: (extraHeight: number) => void;
  enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
  ensureSessionId?: (sessionId: string) => Promise<string>;
};

const CONTENT_GAP_PX = 8;

type ComposerMeasuredExtrasProps = {
  widgets: ReactNode;
  queuePanel?: ReactNode;
  deliveryNotice: ReactNode;
  attachmentBar: ReactNode;
  onHeightChange: (extraHeight: number) => void;
};

/**
 * 必须作为 ComposerRuntimeIntegrations render-prop 子树中的独立组件存在：
 * widget 的关闭/更新只会重渲染这棵子树，不会重渲染外层 ComposerArea。
 * 测量 effect 放在这里，才能在 widget 变化的同一帧回缩面板，而不是等用户输入。
 */
function ComposerMeasuredExtras(props: ComposerMeasuredExtrasProps) {
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
    return Math.ceil(
      widgetsH + imageBarH + (imageBarH > 0 ? gapPx : 0),
    );
  };

  const reportExtra = () => {
    const extra = measureExtra();
    if (extra === lastContentExtraRef.current) return;
    lastContentExtraRef.current = extra;
    onHeightChangeRef.current(extra);
  };

  // props.widgets 变化会重渲染本组件；在 paint 前同步 resize，输入区不会闪高一帧。
  useLayoutEffect(() => {
    if (!mountedRef.current) return;
    reportExtra();
  });

  const hasAttachmentBar = props.attachmentBar != null;
  useEffect(() => {
    let rafId = 0;
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        mountedRef.current = true;
        reportExtra();
      });
    };
    const observer = new ResizeObserver(schedule);
    if (widgetsRef.current) observer.observe(widgetsRef.current);
    if (attachmentBarRef.current) observer.observe(attachmentBarRef.current);
    // 首测延迟到下一帧：此时 ResizablePanel 已注册到 group。
    schedule();
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [hasAttachmentBar]);

  return (
    <>
      <div
        ref={widgetsRef}
        className="flex shrink-0 min-h-0 min-w-0 flex-col gap-2"
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

export const ComposerArea = forwardRef<HTMLElement, ComposerAreaProps>(function ComposerArea(
  props,
  footerRef,
) {
  const composer = useSessionComposerController({
    sessionId: props.sessionId,
    onOpenFile: props.onOpenFile,
    enqueue: props.enqueue,
    ensureSessionId: props.ensureSessionId,
    // 预览 Tab 里发消息 → 自动晋升常驻（由 App 装配的 SessionPaneServices 提供）
    onPromoteSession: useSessionPaneActions().promoteSessionToPermanent,
  });

  const onNativeFileDrop = composer.editor.onNativeFileDrop;
  // Qt delivers OS file drops as a host event because ordinary WebView File objects
  // do not expose absolute paths. Route only the composer under the native drop point;
  // internal HTML drag/drop remains untouched.
  useEffect(() => {
    const handleNativeFileDrop = (event: Event) => {
      const detail = (event as CustomEvent<{ paths?: string[]; clientX?: number; clientY?: number }>).detail;
      if (!detail || !Array.isArray(detail.paths) || detail.paths.length === 0) return;
      const target = typeof detail.clientX === "number" && typeof detail.clientY === "number"
        ? document.elementFromPoint(detail.clientX, detail.clientY)?.closest("[data-session-id]")
        : null;
      if (target?.getAttribute("data-session-id") !== props.sessionId) return;
      onNativeFileDrop(detail.paths);
    };
    window.addEventListener("pideck-native-file-drop", handleNativeFileDrop);
    return () => window.removeEventListener("pideck-native-file-drop", handleNativeFileDrop);
  }, [onNativeFileDrop, props.sessionId]);

  // 并行问询：复用发送按钮旁的行为菜单（常显），选择「并行发送」时走后台匿名会话
  const askPanel = useAskPanel();
  const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
  const store = useStore();
  // 流式生成中切换思考强度产生的「待生效」指示（issue #146）：
  // 飞行中的生成仍用旧档位，新档位下一轮才生效；流式一结束就没有“当前生效”参照，直接清除。
  const [thinkingPendingMap, setThinkingPendingMap] = useAtom(thinkingLevelPendingByIdAtom);
  const modelPendingMap = useAtomValue(modelPendingByIdAtom);
  const isStreaming = Boolean(composer.runtime?.state?.isStreaming);
  useEffect(() => {
    if (!isStreaming && thinkingPendingMap[props.sessionId]) {
      setThinkingPendingMap((prev) =>
        prev[props.sessionId] ? { ...prev, [props.sessionId]: undefined } : prev,
      );
    }
  }, [isStreaming, props.sessionId, setThinkingPendingMap, thinkingPendingMap]);

  /** 并行问询发送：消息投递到独立匿名会话（不打断当前输出），并显示结果胶囊；
   *  点击发送即清空输入框（与正常发送语义一致），失败由胶囊/toast 反馈 */
  const handleAskSend = async () => {
    const text = composer.draft.trim();
    if (!text || !sessionRecord?.projectId) return;
    store.set(setSessionDraftAtom, { sessionId: props.sessionId, value: "" });
    await askPanel.sendToAsk(sessionRecord.projectId, text);
  };
  const prewarmStartedForSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!props.sessionId || !window.piDesktop) return;
    if (!composer.draft.trim() && composer.attachments.length === 0) return;
    if (prewarmStartedForSessionRef.current === props.sessionId) return;
    prewarmStartedForSessionRef.current = props.sessionId;

    // 输入是比“打开会话”更可靠的发送意图信号；只在首次输入后预热一次，
    // 避免用户仅浏览历史时创建进程，也避免每个按键重复触发 IPC。
    void desktopApi.sessions.activateRuntime(props.sessionId).catch(() => undefined);
  }, [composer.attachments.length, composer.draft, props.sessionId]);

  // 受控/非受控双模：SessionView 以面板分隔条控制高度时传 height；
  // 其余场景（测试、嵌入）回退本地默认值，与全局默认高度保持一致；
  // defaultHeight 允许宿主（如居中起始页）指定更高的起步高度，仍随内容自适应增高。
  const [localHeight, setLocalHeight] = useState(props.defaultHeight ?? COMPOSER_DEFAULT_HEIGHT);
  const height = props.height ?? localHeight;
  const handleContentHeightChange = (extra: number) => {
    if (props.height != null) {
      props.onContentHeightChange?.(extra);
    } else if (extra > 0) {
      setLocalHeight((current) =>
        Math.max(current, extra + (props.defaultHeight ?? COMPOSER_DEFAULT_HEIGHT)),
      );
    }
  };

  return (
        <>
          {/* overflow-hidden：面板到 minSize 时禁止整块 footer 再出滚动条；
              文本区自身仍可在 RichInput 内滚动，底栏 shrink-0 始终可见 */}
          <footer
            ref={footerRef}
            className="composer flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden bg-transparent px-0 pb-3"
            style={{
              ...chatContentWidthStyle,
              height: props.height != null ? "100%" : height,
            }}
            data-session-id={props.sessionId}
          >
            {/* 扩展 widget（Todo/Plan）默认走 chat-header chips；composer widgets 槽位可空。
                ComposerMeasuredExtras 负责测量附件/队列/通知高度并驱动 composer 自动增高。 */}
            <ComposerMeasuredExtras
              widgets={props.widgets ?? null}
              queuePanel={props.queuePanel}
              deliveryNotice={(
                <SessionDeliveryNotice
                  status={composer.sendState.status}
                  message={composer.sendState.unknownSnapshot?.message}
                  images={composer.sendState.unknownSnapshot?.images}
                  error={composer.sendState.error}
                  onAcknowledge={composer.delivery.acknowledgeUnknown}
                />
              )}
              attachmentBar={composer.attachments.length > 0 ? (
                <ComposerAttachmentBar
                  images={composer.attachments}
                  onPreview={composer.images.preview}
                  onRemove={composer.images.remove}
                  onClear={composer.images.clear}
                />
              ) : null}
              onHeightChange={handleContentHeightChange}
            />
            <div
              // overflow-visible：保留命令面板/建议浮层；面板 minSize 已保证底栏不被裁切
              className={["composer-box relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-visible rounded-[20px] border border-border bg-card text-card-foreground shadow-[var(--shadow-composer-lifted)] transition-[border-color,box-shadow,background-color]",
                composer.bangMode === "bang-bang"
                  ? "shell-silent-mode"
                  : composer.bangMode === "bang"
                    ? "shell-mode"
                    : composer.mode === "plan"
                      ? "plan-mode"
                      : "",
              ].filter(Boolean).join(" ")}
            >
              {/* 扩展 widget（Todo/Plan）由头部 chips 展示。 */}
              <TipTapComposer
                ref={composer.editor.ref}
                value={composer.draft}
                className={
                  composer.bangMode === "bang-bang"
                    ? "bang-bang"
                    : composer.bangMode === "bang"
                      ? "bang"
                      : ""
                }
                disabled={composer.isStarting}
                validCommandNames={composer.editor.validCommandNames}
                validFilePaths={composer.editor.validFilePaths}
                validSessionRefs={composer.editor.validSessionRefs}
                caretRef={composer.editor.caretRef}
                placeholder={
                  composer.isStarting
                    ? t("app.agentStartingPlaceholder")
                    : composer.bangMode === "bang-bang"
                      ? t("app.composerSilentPlaceholder")
                      : composer.bangMode === "bang"
                        ? t("app.composerShellPlaceholder")
                        : composer.mode === "plan"
                          ? t("app.composerPlanPlaceholder")
                          : t("app.composerEnterPlaceholder")
                }
                onFocus={composer.editor.onFocus}
                onChange={composer.editor.onChange}
                onTextInput={composer.editor.onTextInput}
                onCursorChange={composer.editor.onCursorChange}
                onKeyDown={composer.editor.onKeyDown}
                onPaste={composer.editor.onPaste}
                onPasteClipboard={composer.editor.onPasteClipboard}
                onDrop={composer.editor.onDrop}
                onDragOver={composer.editor.onDragOver}
                onBlur={composer.editor.onBlur}
                onChipClick={composer.editor.onChipClick}
              />
              {composer.suggestions.open && !composer.isStarting ? (
                <PromptSuggestions
                  completionId={composer.suggestions.completionId ?? 0}
                  items={composer.suggestions.items}
                  selectedIndex={composer.suggestions.selectedIndex}
                  anchorStyle={composer.suggestions.anchorStyle}
                  onSelectedIndexChange={composer.suggestions.setSelectedIndex}
                  onClose={composer.suggestions.close}
                  onPick={composer.suggestions.pick}
                />
              ) : null}
              {/* 运行中仍可切换思考强度（下一轮生效）和模型（本轮结束后套上）；仅启动中禁用 */}
              <ComposerBottomBar
                state={composer.runtime?.state}
                compacting={Boolean(composer.runtime?.state?.isCompacting)}
                disabled={composer.isBusy || composer.isStarting}
                thinkingDisabled={composer.isStarting}
                modelDisabled={composer.isStarting}
                thinkingPending={thinkingPendingMap[props.sessionId]}
                modelPending={modelPendingMap[props.sessionId]}
                composerAgentMode={composer.mode}
                gitInfo={props.gitInfo}
                record={composer.record}
                securityControl={
                  /* 安全级别切换是策略快照热更新（安全门每次工具调用重读），运行中即时生效，
                     无需等下一轮生成；因此只保留 Agent 启动中禁用（与思考按钮一致） */
                  <SecurityLevelMenu sessionId={props.sessionId} disabled={composer.isStarting} />
                }
                onPickModel={() => composer.pickers.open("model")}
                onPickThinking={() => composer.pickers.open("thinking")}
                onPickPromptTemplate={() => composer.pickers.open("template")}
                onCompact={composer.delivery.compact}
                onOpenComposerModePicker={() => composer.pickers.open("mode")}
                onCancelPlan={() => composer.pickers.setMode("normal")}
                onAttachFile={composer.editor.attachFile}
                sendControls={
                  <ComposerSendControls
                    isAgentBusy={composer.isBusy}
                    isAgentStarting={composer.isStarting}
                    canSend={composer.delivery.canSend}
                    onSend={composer.delivery.send}
                    onSendFollowUp={composer.delivery.followUp}
                    onSendAsk={() => void handleAskSend()}
                    onStop={composer.delivery.abort}
                  />
                }
              />
            </div>
          </footer>
          <ComposerPickerHost
            sessionId={props.sessionId}
            picker={composer.picker}
            templates={composer.templates}
            onClose={composer.pickers.close}
            onInsertTemplate={composer.pickers.insertTemplate}
          />
          {composer.previewImage ? (
            <ImagePreviewModal
              image={composer.previewImage}
              onClose={composer.modals.closePreview}
            />
          ) : null}
          {composer.sessionReference ? (
            <SessionReferenceModal
              session={composer.sessionReference}
              initialSelected={composer.sessionReferenceSelection
                ? new Set(composer.sessionReferenceSelection.selectedIndices)
                : undefined}
              onClose={composer.modals.closeSessionReference}
              onConfirm={(result, selectedIndices) => {
                composer.modals.confirmSessionReference(
                  result.sessionName,
                  result.messages,
                  selectedIndices,
                );
              }}
              loadMessages={(sessionId) => desktopApi.sessions.readReferenceMessages(sessionId)}
            />
          ) : null}
        </>
  );
});
