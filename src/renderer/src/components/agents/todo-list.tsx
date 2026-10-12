"use client";
// Official BeUI Todo List — beui.dev/components/agents/todo-list
// 官方 registry 源（https://beui.dev/r/todo-list.json）的忠实本地拷贝：
// - 结构、API、动画（TodoHeaderIcon / TodoStatusIcon / AgentDisclosure / ActionSwapRollText /
//   collapseOnComplete 自动折叠与 reopen）保持官方原样；
// - 与仓库约定的适配：用户可见文案走 i18n（AGENTS.md 硬性要求）、
//   scrollbar-hide 换成 Tailwind 任意属性（仓库不引入第三方 scrollbar 工具类）；
// - 额外的 `compact` 可选密度开关（默认 false = 官方类/行为原样）：仅由 PiDeck
//   宿主（Header Popover）传入，把官方 text-sm/text-xs 换成 PiDeck 语义字号 token
//   （字号体系 text-widget > text-widget-item > text-widget-detail：默认 11/10/9px，
//   均比右侧徽章小且随「界面字号」联动，窄窗口 vw 收缩；计数用 text-caption）并收紧垂直度量
//   （h-11→h-9、单行 min-h-9→min-h-5）；compact 头部 pr-8 为宿主层关闭按钮预留空间。
// - `embedded` 仅供 Header Popover：去掉内部折叠按钮，直接展示列表；官方默认行为不变。
// - 已完成的 todo 项去掉官方删除线（横线动画）：状态图标已有对勾标记，删除线
//   属冗余视觉；仅当“保持官方逐字节一致”与产品取舍冲突时按后者（2026-12 用户要求）。
// - 共享运动常量来自 @/lib/ease（官方值 SPRING_SWAP/SPRING_PRESS 已并入）。

import { ChevronDown, ListTodo } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActionSwapRollText } from "@/components/motion/action-swap-roll";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { t } from "@/i18n";
import {
  EASE_OUT,
  SPRING_LAYOUT,
  SPRING_SWAP,
} from "@/lib/ease";
import { cn } from "@/lib/utils";

export type TodoItemStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "cancelled";

export interface TodoItem {
  id: string;
  title: ReactNode;
  status?: TodoItemStatus;
  progress?: number;
  detail?: ReactNode;
}

export interface TodoListProps {
  items: TodoItem[];
  title?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  /** PiDeck 桌面紧凑密度开关；默认 false 保持官方类与行为，仅宿主（Header Popover）传入。 */
  compact?: boolean;
  /** Popover 已有触发器：嵌入时直接展示内容，不再提供第二个折叠按钮。 */
  embedded?: boolean;
  className?: string;
}

function statusLabel(status: TodoItemStatus) {
  if (status === "in-progress") return t("app.todoStatusInProgress");
  if (status === "completed") return t("app.todoStatusCompleted");
  if (status === "cancelled") return t("app.todoStatusCancelled");
  return t("app.todoStatusPending");
}

function TodoHeaderIcon({ complete }: { complete: boolean }) {
  const reduce = useReducedMotion() ?? false;

  return (
    <span
      aria-hidden="true"
      className="relative grid size-6 shrink-0 place-items-center"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {complete ? (
          <motion.svg
            key="complete"
            viewBox="0 0 24 24"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.72 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="absolute size-5.5 overflow-visible text-emerald-500"
          >
            <circle cx="12" cy="12" r="9" fill="currentColor" />
            <motion.path
              d="M7.5 12.25 10.5 15.25 16.75 8.75"
              fill="none"
              stroke="white"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={
                reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }
              }
            />
          </motion.svg>
        ) : (
          <motion.span
            key="todo"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.72 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="absolute grid place-items-center text-muted-foreground"
          >
            <ListTodo className="size-4" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function TodoStatusIcon({
  status,
  progress,
  compact = false,
}: {
  status: TodoItemStatus;
  progress?: number;
  compact?: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const normalizedProgress =
    progress === undefined ? 0.68 : Math.min(100, Math.max(0, progress)) / 100;

  return (
    <motion.svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      initial={false}
      className={cn(
        "mx-0.5 shrink-0 overflow-visible text-muted-foreground",
        // 状态图标随 compact 收两档：官方 size-5（20px）配 text-sm；compact 条目 10px 时
        // 用 size-3.5（14px）保持同比例，也略大于 chip 图标（11px）以示层级
        compact ? "size-3.5" : "size-5",
        status === "in-progress" && "text-foreground",
        status === "cancelled" && "text-rose-600 dark:text-rose-400",
      )}
    >
      <motion.circle
        cx="12"
        cy="12"
        r="9"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={status === "pending" ? "2 3" : undefined}
        strokeLinecap="round"
        initial={false}
        animate={{ fillOpacity: status === "completed" ? 0.06 : 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
        className={cn(status === "in-progress" && "opacity-20")}
      />
      <motion.circle
        cx="12"
        cy="12"
        r="9"
        pathLength="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        initial={false}
        animate={{
          pathLength: status === "in-progress" ? normalizedProgress : 0,
          opacity: status === "in-progress" ? 1 : 0,
          rotate:
            status === "in-progress" && progress === undefined && !reduce
              ? 360
              : -90,
        }}
        transition={
          status === "in-progress" && progress === undefined && !reduce
            ? { rotate: { duration: 1.1, repeat: Infinity, ease: "linear" } }
            : reduce
              ? { duration: 0 }
              : SPRING_LAYOUT
        }
        style={{ transformOrigin: "12px 12px" }}
      />
      <motion.path
        d="M7.5 12.25 10.5 15.25 16.75 8.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={false}
        animate={{
          pathLength: status === "completed" ? 1 : 0,
          opacity: status === "completed" ? 1 : 0,
        }}
        transition={reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }}
      />
      <motion.path
        d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        initial={false}
        animate={{
          pathLength: status === "cancelled" ? 1 : 0,
          opacity: status === "cancelled" ? 1 : 0,
        }}
        transition={reduce ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }}
      />
    </motion.svg>
  );
}

export function TodoList({
  items,
  title = t("app.todoListTitle"),
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight = 248,
  compact = false,
  embedded = false,
  className,
}: TodoListProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousComplete = useRef(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  const completed = items.filter((item) => item.status === "completed").length;
  const allComplete = items.length > 0 && completed === items.length;
  const itemCount = items.length;
  // 嵌入 Popover 时标题按钮不存在；使用宿主传入的文本标题命名区域，
  // 非文本标题无法安全转成纯文本，沿用已有的本地化通用名称。
  const accessibleLabel = embedded && typeof title === "string" && title.trim()
    ? title.trim()
    : t("app.todoListAriaLabel");

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );

  // 官方行为：全部完成自动折叠；之后出现新工作（未完成项）自动重新展开。
  useEffect(() => {
    // Popover 的打开/关闭由外层负责；完成态不能再把内部列表折叠掉。
    if (embedded) return;
    if (previousComplete.current && !allComplete) {
      setOpen(true);
    }
    if (!previousComplete.current && allComplete && collapseOnComplete) {
      setOpen(false);
    }
    previousComplete.current = allComplete;
  }, [allComplete, collapseOnComplete, embedded, setOpen]);

  // 新 item 追加后滚动到底（reduced-motion 下直接跳转）。
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || itemCount === 0) return;

    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: reduce ? "auto" : "smooth",
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [itemCount, reduce]);

  return (
    <section
      aria-label={accessibleLabel}
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-border/70",
        className,
      )}
    >
      {!embedded && <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className={cn(
          "group flex w-full items-center rounded-2xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          // 官方默认 h-11/gap-2.5/px-3.5；compact 收紧为 h-9，其中 pr-8 为宿主层
          // 关闭按钮预留右上角空间（叠放的 X 不盖住折叠 chevron），默认分支不生效
          compact ? "h-9 gap-2 pl-3 pr-8" : "h-11 gap-2.5 px-3.5",
        )}
      >
        <TodoHeaderIcon complete={allComplete} />
        <h3
          className={cn(
            "min-w-0 flex-1 truncate font-medium text-foreground/90",
            compact ? "text-widget" : "text-sm",
          )}
        >
          {title}
        </h3>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums text-muted-foreground",
            compact ? "text-caption" : "text-xs",
            allComplete && "text-emerald-600 dark:text-emerald-400",
          )}
        >
          <span className="sr-only">
            {t("app.todoCompletedCount", {
              completed,
              total: items.length,
            })}
          </span>
          <span aria-hidden="true" className="inline-flex">
            <ActionSwapRollText value={String(completed)}>
              {completed}
            </ActionSwapRollText>
            <span>/</span>
            <span>{items.length}</span>
          </span>
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
        >
          <ChevronDown className={compact ? "size-3" : "size-3.5"} />
        </motion.span>
      </button>}

      <AgentDisclosure
        id={contentId}
        role="region"
        aria-labelledby={embedded ? undefined : triggerId}
        aria-label={embedded ? accessibleLabel : undefined}
        open={embedded || currentOpen}
      >
        <div
          ref={viewportRef}
          className={embedded ? "overflow-y-auto px-2 py-1.5 [scrollbar-width:none]" : "overflow-y-auto px-2 pb-2 [scrollbar-width:none]"}
          style={{ maxHeight }}
        >
          {items.length ? (
            <ol aria-live="polite" className="space-y-0">
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((item) => {
                const status = item.status ?? "pending";
                return (
                  <motion.li
                    layout="position"
                    key={item.id}
                    initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                    transition={
                      reduce
                        ? { duration: 0 }
                        : {
                            opacity: { duration: 0.18, ease: EASE_OUT },
                            y: SPRING_LAYOUT,
                            layout: SPRING_LAYOUT,
                          }
                    }
                    className={cn(
                      // items-start：标题允许多行换行后，状态图标与 detail 顶部对齐首行（items-center
                      // 会把图标/摘要垂直居中在整块多行文字上，视觉会偏下）。
                      "flex items-start rounded-xl px-1.5",
                      // 官方行距不变；Popover 单行约 20px，长标题换行时自然增高。
                      compact ? "min-h-5 gap-1.5 py-0.5" : "min-h-9 gap-2.5 py-1",
                    )}
                  >
                    <TodoStatusIcon
                      status={status}
                      progress={item.progress}
                      compact={compact}
                    />
                    <span className="sr-only">{statusLabel(status)}: </span>
                    {/* 标题允许多行换行显示全文：去掉官方单行 truncate，长文案（尤其 plan 步骤的完整描述）
                        不再被省略号截断；flex-1 + min-w-0 保证行内可分配宽度并参与换行，
                        break-words 兜底超长未断字符（如 URL）也能断行。 */}
                    <span
                      className={cn(
                        "min-w-0 flex-1 break-words",
                        // ⚠️ 不能写 text-widget-item（命名 token 形式）：tailwind-merge 会把
                        // 未知的 text-* 误判为颜色类，与下方状态色 text-muted-foreground/65
                        // 同组冲突而被丢弃（条目会退回继承 body 14px——“字体特别大”的根因）。
                        // text-[length:var(--text-widget-item)] 显式声明字号类型，twMerge 归入
                        // font-size 组，与颜色类共存；官方分支 text-sm 是内置字号白名单，无此问题。
                        compact
                          ? "text-[length:var(--text-widget-item)]"
                          : "text-sm leading-5",
                        // 2027-01 用户要求条目文字“黑色”：pending 与 in-progress 同用
                        // 前景色；完成/取消保留淡色弱化（☑ 对勾已足够区分完成态）
                        status === "pending" && "text-foreground",
                        status === "in-progress" && "text-foreground",
                        status === "completed" && "text-muted-foreground/60",
                        status === "cancelled" && "text-muted-foreground/55",
                      )}
                    >
                      {item.title}
                    </span>
                    {item.detail ? (
                      <span
                        className={cn(
                          "shrink-0",
                          // 与条目同理：text-widget-detail 会被 twMerge 误删或反删颜色，
                          // 用显式 length: 类型声明与状态色共存
                          compact
                            ? "text-[length:var(--text-widget-detail)] text-muted-foreground/55"
                            : "text-sm text-muted-foreground/55",
                        )}
                      >
                        {item.detail}
                      </span>
                    ) : null}
                  </motion.li>
                );
              })}
            </AnimatePresence>
            </ol>
          ) : (
            <p
              className={cn(
                "px-1.5 py-2 text-muted-foreground",
                compact ? "text-widget" : "text-sm",
              )}
            >
              {t("app.todoListEmpty")}
            </p>
          )}
        </div>
      </AgentDisclosure>
    </section>
  );
}
