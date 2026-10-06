"use client";

import { type CSSProperties, Fragment, useEffect, useState } from "react";
import {
  cacheTokens,
  getCachedTokens,
  type AgentCodeToken,
  type AgentCodeTokenLines,
} from "./agentCodeTokenCache";
import {
  type AgentCodeHighlightClient,
  createAgentCodeHighlightClient,
} from "./agentCodeHighlightClient";
import type { AgentCodeLanguage } from "./agentHighlightTypes";
import { cn } from "@/lib/utils";

// 语言枚举定义在 agentHighlightTypes（Worker 协议共用），这里转出以保持既有导入路径。
export type { AgentCodeLanguage } from "./agentHighlightTypes";

export type { AgentCodeToken, AgentCodeTokenLines } from "./agentCodeTokenCache";
export interface AgentCodeProps {
  code: string;
  language?: AgentCodeLanguage;
  className?: string;
}

export interface AgentCodeLineProps {
  code: string;
  tokens?: AgentCodeToken[];
  className?: string;
}

function tokenCacheKey(code: string, language: AgentCodeLanguage) {
  return `${language}\u0000${code}`;
}

// 页面级单例：一个 Worker + 一套排队/取消/超时策略都由 client 负责
// （见 agentCodeHighlightClient.ts）。高亮计算放在 Worker 里，
// 因为 shiki 的 codeToTokensWithThemes 是同步 CPU 计算，留在主线程会阻塞输入帧。
let agentCodeHighlightClient: AgentCodeHighlightClient | null = null;

function getAgentCodeHighlightClient(): AgentCodeHighlightClient {
  if (!agentCodeHighlightClient) {
    agentCodeHighlightClient = createAgentCodeHighlightClient({
      // Worker 入口 URL 只在工厂模块里解析；这里动态加载，使 client 与 hook
      // 能在 Node 单测中被静态加载并注入替身 Worker。
      createWorker: async () => {
        const { createAgentCodeHighlightWorker } = await import(
          "./agentCodeHighlightWorkerFactory"
        );
        return createAgentCodeHighlightWorker();
      },
    });
  }
  return agentCodeHighlightClient;
}

export function useAgentCodeTokens(
  code: string,
  language: AgentCodeLanguage,
) {
  const key = tokenCacheKey(code, language);
  const cached = getCachedTokens(key);
  const [result, setResult] = useState<{
    key: string;
    code: string;
    language: AgentCodeLanguage;
    lines: AgentCodeTokenLines;
  } | null>(cached ? { key, code, language, lines: cached } : null);

  useEffect(() => {
    const current = getCachedTokens(key);
    if (current) {
      setResult({ key, code, language, lines: current });
      return;
    }

    let cancelled = false;
    const handle = getAgentCodeHighlightClient().request(code, language);
    handle.promise
      .then((lines) => {
        if (cancelled) return;
        cacheTokens(key, lines);
        setResult({ key, code, language, lines });
      })
      .catch(() => {
        // Worker 失败/超时：不设结果，上层按纯文本呈现（可读、无高亮）。
        // 刻意不做主线程回退——回退等于把卡顿搬回来，还会掩盖 Worker 失败。
      });
    return () => {
      cancelled = true;
      // 只取消本消费者；同一段代码的其它消费者仍会拿到结果。
      handle.cancel();
    };
  }, [code, key, language]);

  if (result?.key === key) return result.lines;
  return null;
}

export function AgentCodeLine({
  code,
  tokens,
  className,
}: AgentCodeLineProps) {
  return (
    <span className={className}>
      {tokens
        ? tokens.map((token) => (
            <span
              key={`${token.offset}-${token.content}`}
              style={
                {
                  "--agent-code-light": token.light ?? "currentColor",
                  "--agent-code-dark": token.dark ?? token.light ?? "currentColor",
                } as CSSProperties
              }
              className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]"
            >
              {token.content}
            </span>
          ))
        : code}
    </span>
  );
}

export function AgentCode({
  code,
  language = "bash",
  className,
}: AgentCodeProps) {
  const tokens = useAgentCodeTokens(code, language);
  let offset = 0;
  const lines = code.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });

  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto whitespace-pre font-mono text-xs leading-5 text-foreground/85",
        className,
      )}
    >
      <code>
        {lines.map((line, index) => (
          <Fragment key={line.offset}>
            <AgentCodeLine code={line.content} tokens={tokens?.[index]} />
            {index < lines.length - 1 ? "\n" : null}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}
