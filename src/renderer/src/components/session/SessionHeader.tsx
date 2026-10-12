import { HatGlasses, Maximize2 } from "lucide-react";
import { useAtomValue } from "jotai";
import { type ReactNode, type RefObject } from "react";
import type { AgentRuntimeState } from "../../../../shared/types";
import {
  sessionCacheStatsAtom,
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sessionSendStateAtomFamily,
  projectByIdAtomFamily,
} from "../../atoms";
import { isUserFacingSessionStart } from "../../hooks/useSessionTimelineController";
import { t } from "../../i18n";
import { displayProjectDirectoryName } from "../../rendererUtils";
import { Button } from "../ui-shadcn/button";
import { ContextControllerSwitches } from "./ContextControllerSwitches";
import { SessionStatus } from "./SurfaceParts";

type HeaderActions = {
  headerRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  compactionCount?: number;
  isAnonymous?: boolean;
  duration?: number;
  /** 将状态/操作区嵌入 Tab 栏，避免当前会话再单独占一行。 */
  embedded?: boolean;
  /** 头部左侧槽位（Todo/Plan 等扩展 widget chips）；会话标题迁走后左侧留空，widget 入口落在这里。 */
  widgetChips?: ReactNode;
  /**
   * 项目目录名（面包屑左段）：多 Tab/分屏时提醒当前会话属于哪个项目。
   * legacy 模式由上层传入；session 模式可从会话记录自行解析。
   */
  projectName?: string;
  /**
   * 分屏栏内显示本栏会话标题，避免「共享顶栏 Tab ↔ 左右栏」对不上号。
   * 单栏时标题已在外置 Tab 上，通常不传。
   */
  paneTitle?: string;
  /** 退出会话分屏（扩大为单栏）；仅分屏时提供 */
  onExitSplit?: () => void;
};

type LegacySessionHeaderProps = HeaderActions & {
  mode?: "legacy";
  title: string;
  runtimeState?: AgentRuntimeState;
  isStarting: boolean;
};

type ModernSessionHeaderProps = HeaderActions & {
  mode: "session";
  sessionId: string;
  title?: never;
  runtimeState?: never;
  isStarting?: never;
  hasSession?: never;
};

export type SessionHeaderProps = LegacySessionHeaderProps | ModernSessionHeaderProps;

/**
 * 渲染会话状态徽章（+ 分屏身份标题）。
 * 会话运行控制（停止/重启）已迁入 Tab 下拉（SessionTabsBar 的 canStopCurrent 链路），
 * 此组件不再承载操作菜单；embedded 模式供 Tab 栏 actions 复用；普通模式保留
 * 分屏 pane 外壳（paneTitle + 退出分屏）。
 */
export function SessionHeader(props: SessionHeaderProps) {
  const sessionMode = props.mode === "session";
  const sessionId = props.sessionId ?? "";
  const legacyProps = props as LegacySessionHeaderProps;
  const session = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  // 会话级缓存命中率历史（统计快照由 runtime 事件写入 atom），供状态入口展示。
  const cacheStats = useAtomValue(sessionCacheStatsAtom);
  // 与 SessionMessageTimeline / ContextControllerSwitches / ComposerArea 共用同一个按会话选择器。
  const sendState = useAtomValue(sessionSendStateAtomFamily(sessionId));

  // SessionView 仍走 legacy 装配，不能只在 mode=session 时读 atom；
  // 否则 injector 漏传 activeRuntimeState 时，底栏已有「压缩 42%」，顶栏却空白。
  const runtimeState = runtime?.state ?? (sessionMode ? undefined : legacyProps.runtimeState);
  // session 模式也只认用户发送；预热 starting 不能给标题栏加 loading（会顶高/半透明）。
  const isStarting = sessionMode
    ? isUserFacingSessionStart(sendState?.status)
    : legacyProps.isStarting;
  const isAnonymous = props.isAnonymous || (sessionMode && session?.noSession === true);
  // 项目名：session 模式从会话记录解析 projectId → 项目目录名；
  // legacy 模式（无 sessionId）由上层通过 projectName 传入。
  const project = useAtomValue(projectByIdAtomFamily(session?.projectId ?? ""));
  const projectName = props.projectName ?? (project ? displayProjectDirectoryName(project) : undefined);
  // 会话标题：分屏优先用 paneTitle，其次 legacy title / session 模式记录标题。
  const title = props.paneTitle ?? (sessionMode ? session?.title?.trim() || t("app.chatProject") : props.title);

  const actions = (
    <div
      ref={props.embedded ? props.headerRef : undefined}
      className={`chat-header-actions flex min-w-0 max-w-full shrink items-center justify-end gap-1.5 overflow-hidden${props.embedded ? " h-7 w-auto" : ""}${isStarting ? " loading" : ""}`}
    >
      {props.widgetChips}
      {isAnonymous && (
        <span className="anonymous-badge" title={t("app.anonymousChat")} aria-label={t("app.anonymousChat")}>
          <HatGlasses size={14} aria-hidden="true" />
        </span>
      )}
      {sessionId ? <ContextControllerSwitches sessionId={sessionId} /> : null}
      <div className="shrink-0">
        <SessionStatus state={runtimeState} duration={props.duration} cacheHitHistory={cacheStats[sessionId]?.cacheHitHistory} />
      </div>
    </div>
  );

  if (props.embedded) return actions;
  return (
    <div
      ref={props.headerRef}
      role="banner"
      /* 普通模式：分屏 pane 的会话身份行（Tab 已外置）。
         底部分隔线去掉：分屏身份标题下再叠一条线过于碎。 */
      className="chat-header grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-center gap-2 bg-background px-3 py-1"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {props.onExitSplit ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            title={t("session.split.exit")}
            aria-label={t("session.split.exit")}
            onClick={(event) => {
              event.stopPropagation();
              props.onExitSplit?.();
            }}
          >
            <Maximize2 className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
        {/* 会话身份面包屑：项目名 / 会话标题。
            truncate + max-w 限制：项目名最长约 160px，标题吃剩余空间；
            悬浮 title 显示完整文本。 */}
        {projectName ? (
          <span
            className="max-w-40 shrink truncate text-caption text-muted-foreground"
            title={projectName}
          >
            {projectName}
          </span>
        ) : null}
        {projectName && title ? (
          <span className="shrink-0 text-caption text-muted-foreground/70" aria-hidden="true">/</span>
        ) : null}
        {title ? (
          <span
            className="session-pane-title min-w-0 max-w-96 truncate text-caption font-medium text-foreground"
            title={title}
          >
            {title}
          </span>
        ) : (
          <span className="min-w-0" aria-hidden="true" />
        )}
      </div>
      {actions}
    </div>
  );
}
