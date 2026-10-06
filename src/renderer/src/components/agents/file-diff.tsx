"use client";
// beui.dev/components/agents/file-diff

import {
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  LoaderCircle,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type AgentCodeLanguage,
  AgentCodeLine,
  useAgentCodeTokens,
} from "@/components/agents/agent-code";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type FileDiffStatus = "streaming" | "complete";
export type FileDiffLineType = "added" | "removed" | "context";

export interface FileDiffLine {
  id: string;
  type?: FileDiffLineType;
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface FileDiffProps {
  file: ReactNode;
  lines: FileDiffLine[];
  status?: FileDiffStatus;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  language?: AgentCodeLanguage;
  copyText?: string;
  onCopy?: () => void | Promise<void>;
  className?: string;
}

function ChangeCount({ value, type }: { value: number; type: "added" | "removed" }) {
  if (!value) return null;
  return (
    <span
      className={cn(
        "font-mono text-xs tabular-nums",
        type === "added"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-rose-600 dark:text-rose-400",
      )}
    >
      {type === "added" ? "+" : "−"}
      {value}
    </span>
  );
}

/**
 * 展开态的 diff 正文：逐行 DOM、Shiki 高亮与复制按钮都只在这里构建。
 *
 * 为什么单独拆组件而不是在 FileDiff 内部用条件表达式渲染同一段 JSX：
 * `useAgentCodeTokens`（Shiki）是钩子，不能进条件分支；只有整块不挂载
 * 才能真正跳过「拼接全文 + 高亮 + 逐行节点」的成本。收起的长会话里
 * 每轮底部可能挂几十个文件，全部留在文档里会让输入等待布局。
 */
function FileDiffBody({
  lines,
  language,
  maxHeight,
  streaming,
  reduce,
  copied,
  canCopy,
  onCopy,
}: {
  lines: FileDiffLine[];
  language: AgentCodeLanguage;
  maxHeight: number;
  streaming: boolean;
  reduce: boolean;
  copied: boolean;
  canCopy: boolean;
  onCopy: () => void | Promise<void>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const code = lines.map((line) => line.content).join("\n");
  const tokens = useAgentCodeTokens(code, language);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !streaming) return;

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
  });

  return (
    <div className="pl-5 pt-1">
      <div className="overflow-hidden rounded-md bg-muted/80">
        <div
          ref={viewportRef}
          data-slot="file-diff-viewport"
          aria-live="polite"
          className="scrollbar-hide overflow-auto"
          style={{ maxHeight }}
        >
          <div className="font-mono text-xs leading-5">
            <span className="sr-only">File changes</span>
            {lines.map((line, index) => {
              const type = line.type ?? "context";
              return (
                <div
                  key={line.id}
                  className={cn(
                    "grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)]",
                    type === "added" && "bg-emerald-500/[0.07]",
                    type === "removed" && "bg-rose-500/[0.07]",
                  )}
                >
                  <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">
                    {line.oldLine}
                  </span>
                  <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">
                    {line.newLine}
                  </span>
                  <span
                    className={cn(
                      "select-none text-center text-muted-foreground/45",
                      type === "added" &&
                        "text-emerald-600 dark:text-emerald-400",
                      type === "removed" &&
                        "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {type === "added"
                      ? "+"
                      : type === "removed"
                        ? "−"
                        : ""}
                  </span>
                  <AgentCodeLine
                    code={line.content}
                    tokens={tokens?.[index]}
                    className="min-w-0 whitespace-pre px-1.5"
                  />
                </div>
              );
            })}
          </div>
        </div>

        {canCopy ? (
          <div className="flex justify-end px-2 pb-1.5 pt-1">
            <motion.button
              type="button"
              aria-label={copied ? "Copied" : "Copy diff"}
              title={copied ? "Copied" : "Copy diff"}
              onClick={onCopy}
              whileTap={reduce ? undefined : { scale: 0.9 }}
              transition={SPRING_PRESS}
              className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </motion.button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function FileDiff({
  file,
  lines,
  status = "streaming",
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight = 220,
  language = "typescript",
  copyText,
  onCopy,
  className,
}: FileDiffProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const previousStatus = useRef(status);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  const streaming = status === "streaming";
  const additions = lines.filter((line) => line.type === "added").length;
  const deletions = lines.filter((line) => line.type === "removed").length;
  const canCopy = Boolean(copyText || onCopy);

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (previousStatus.current !== "streaming" && status === "streaming") {
      setOpen(true);
    }
    if (
      previousStatus.current === "streaming" &&
      status === "complete" &&
      collapseOnComplete
    ) {
      setOpen(false);
    }
    previousStatus.current = status;
  }, [collapseOnComplete, setOpen, status]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else if (copyText) await navigator.clipboard?.writeText(copyText);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [copyText, onCopy]);

  return (
    <div
      data-state={status}
      aria-busy={streaming}
      className={cn("w-full text-sm", className)}
    >
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex min-h-7 w-full items-center gap-1.5 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <FileCode2
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">
          {file}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <ChangeCount value={additions} type="added" />
          <ChangeCount value={deletions} type="removed" />
        </span>
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground/60">
          {streaming ? (
            <LoaderCircle
              aria-label="Applying changes"
              className={cn("size-3.5", !reduce && "animate-spin")}
            />
          ) : (
            <Check aria-label="Changes applied" className="size-3.5" />
          )}
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>

      <AgentDisclosure
        id={contentId}
        role="region"
        aria-labelledby={triggerId}
        open={currentOpen}
      >
        {/* 收起且不在流式中时整块不挂载：逐行节点、Shiki 高亮与拼接全文全部省掉。
            不用 CSS 把正文藏起来——那只是把节点留在文档里，
            布局与样式重算的成本照旧。流式中保持挂载以跟随滚动，
            状态变为 complete 后上面的 effect 会收起，正文随之卸载。 */}
        {(currentOpen || streaming) && (
          <FileDiffBody
            lines={lines}
            language={language}
            maxHeight={maxHeight}
            streaming={streaming}
            reduce={reduce}
            copied={copied}
            canCopy={canCopy}
            onCopy={handleCopy}
          />
        )}
      </AgentDisclosure>
    </div>
  );
}
