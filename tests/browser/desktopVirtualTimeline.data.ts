import type { ChatMessage } from "../../src/shared/types";
import type { TimelineRowItem } from "../../src/renderer/src/components/session/timeline/timelineRowModel";

export function generateIntegratedMessages(count = 100, codeLines = 1, longRows = false): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      id: `u-${i}`,
      agentId: "agent-1",
      role: "user",
      text: longRows
        ? Array.from({ length: 90 }, (_, line) => `用户问题 ${i} 第 ${line} 行，稳定历史中的长段落应当保持当前阅读位置。`).join("\n")
        : `用户问题 #${i}: 真实集成装配长会话压力测试，验证 SessionMessageTimeline 与 MessageScroller 的协同表现。`,
      timestamp: 1700000000000 + i * 2000,
    });
    msgs.push({
      id: `a-${i}`,
      agentId: "agent-1",
      role: "assistant",
      text: (longRows ? Array.from({ length: 65 }, (_, line) => `助手回答 ${i} 第 ${line} 段，已结束的长回复在重新挂载和持续向上滚动时保持可见段落。`).join("\n\n") + "\n\n" : "") + `助手回答 #${i}: 真实时间线装配渲染。每轮回答包含 Markdown 与代码块。\n\n\`\`\`ts\n${Array.from({ length: codeLines }, (_, line) => `const turn_${i}_${line} = ${i};`).join("\n")}\n\`\`\``,
      timestamp: 1700000000000 + i * 2000 + 1000,
    });
  }
  return msgs;
}

// 构建 2000 行包含多种结构的消息 fixture
export function generate2000Items(): TimelineRowItem[] {
  const items: TimelineRowItem[] = [];
  for (let i = 0; i < 2000; i++) {
    if (i % 2 === 0) {
      items.push({
        kind: "message",
        message: {
          id: `msg-user-${i}`,
          agentId: "agent-1",
          role: "user",
          text: `用户问题 #${i}: 这是一个虚拟列表滚动的压力测试，用于检验长会话流畅度。`,
          timestamp: 1700000000000 + i * 1000,
        },
      });
    } else {
      items.push({
        kind: "agent-run",
        id: `run-${i}`,
        startedAt: 1700000000000 + i * 1000,
        endedAt: 1700000000000 + i * 1000 + 500,
        items: [
          {
            kind: "message",
            message: {
              id: `msg-asst-${i}`,
              agentId: "agent-1",
              role: "assistant",
              text: `助手回答 #${i}: 回答内容具有不同的行高与结构。第 ${i} 行包含了详细的解释与代码片段。\n\n\`\`\`ts\nconst val_${i} = ${i};\n\`\`\``,
              timestamp: 1700000000000 + i * 1000 + 200,
            },
          },
        ],
      });
    }
  }
  return items;
}
