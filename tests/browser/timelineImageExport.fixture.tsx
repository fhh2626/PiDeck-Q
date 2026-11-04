import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReadOnlyExportDocument } from "../../src/renderer/src/components/session/timeline/ReadOnlyExportMarkdown";
import {
  buildExportDocumentModel,
  type ExportDocumentModel,
} from "../../src/renderer/src/components/session/timeline/imageExportModel";
import type { TimelineRowItem } from "../../src/renderer/src/components/session/timeline/timelineRowModel";

const sampleItems: TimelineRowItem[] = [
  {
    kind: "message",
    message: {
      id: "msg-1",
      agentId: "agent-1",
      role: "user",
      text: "请导出我的分析结果以及思考过程。",
      timestamp: 1700000000000,
    },
  },
  {
    kind: "agent-run",
    id: "run-1",
    startedAt: 1700000001000,
    endedAt: 1700000005000,
    items: [
      {
        kind: "thinking-group",
        id: "tg-1",
        text: "这里是长思考过程，绝不能在长图导出时被截断或遗漏。",
        startedAt: 1700000001000,
        endedAt: 1700000002000,
        messages: [
          {
            id: "msg-think-1",
            agentId: "agent-1",
            role: "assistant",
            text: "这里是长思考过程，绝不能在长图导出时被截断或遗漏。",
            thinking: "这里是长思考过程，绝不能在长图导出时被截断或遗漏。",
            timestamp: 1700000002000,
          },
        ],
      },
      {
        kind: "message",
        message: {
          id: "msg-ans-1",
          agentId: "agent-1",
          role: "assistant",
          text: "这是最终的 Markdown 回答内容，包含公式与表格展示。",
          timestamp: 1700000002500,
        },
      },
      {
        kind: "tool-group",
        id: "group-1",
        messages: [
          {
            id: "tool-1",
            agentId: "agent-1",
            role: "tool",
            text: "执行结果详情：全量数据，无 40 张分页截断",
            timestamp: 1700000003000,
            meta: {
              toolName: "analyze_data",
              status: "done",
              input: JSON.stringify({ query: "SELECT * FROM users", limit: 100 }),
            },
          },
        ],
      },
    ],
  },
];

function TimelineImageExportFixture() {
  const [model, setModel] = useState<ExportDocumentModel | null>(null);

  const handleBuildExport = () => {
    const built = buildExportDocumentModel(sampleItems, new Map(), true);
    setModel(built);
  };

  return (
    <div style={{ padding: "24px", maxWidth: "800px", margin: "0 auto" }}>
      <header style={{ marginBottom: "16px", display: "flex", gap: "12px" }}>
        <button id="btn-build-export" onClick={handleBuildExport}>
          生成只读导出模型
        </button>
      </header>

      {model && (
        <div
          id="export-render-container"
          style={{
            background: "#18181b",
            padding: "24px",
            borderRadius: "8px",
            border: "1px solid #27272a",
          }}
        >
          <ReadOnlyExportDocument model={model} />
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<TimelineImageExportFixture />);
}
