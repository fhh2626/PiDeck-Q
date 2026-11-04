/**
 * 对话时间线领域模型（纯类型，无 React 依赖）。
 *
 * 展示层将一轮 agent-run 展开为「扁平展示序列」（TurnDisplayItem）：
 * - process-entry：思考/工具步骤，原位出现，受 run 级折叠开关控制显隐；
 * - interim-answer：中间回答（本轮非最后一条 assistant 文本），同样受折叠控制；
 * - final-answer：最终回答（本轮最后一条 assistant 文本），常驻、永不折叠。
 *   提问说明也走 final-answer：当前轮 pending ask，或后面紧跟 ask_question/_askCard。
 * - ask-result：已完成的 ask_question 问答结果，常驻、永不折叠（与 final-answer 同级，
 *   但不参与 assistant 文本聚合）。问题与用户回答始终可见，不受执行过程折叠影响。
 *
 * 领域对象类型（AgentRunItem / ThinkingGroupItem / ToolGroupItem）目前暂存于
 * AppUtils.ts，随重构逐步迁移至此；本模块只定义展示层新增类型，避免大爆炸。
 */
import type { AgentRunItem, MessageItem, ThinkingGroupItem, ToolGroupItem, RenderMessage } from "../../app/AppUtils";
import type { ChatMessage, AskQuestionResultSummary } from "../../../../../shared/types";

export type { AgentRunItem, MessageItem, ThinkingGroupItem, ToolGroupItem, RenderMessage };

/** 单个执行过程条目：思考步骤或工具步骤。 */
export type TurnProcessEntry =
	| { kind: "thinking-entry"; id: string; group: ThinkingGroupItem }
	| { kind: "tool-entry"; id: string; group: ToolGroupItem };

/** 扁平展示序列中的一个节点。 */
export type TurnDisplayItem =
	| { kind: "process-entry"; entry: TurnProcessEntry }
	| { kind: "interim-answer"; id: string; message: ChatMessage }
	| { kind: "final-answer"; id: string; message: ChatMessage }
	| { kind: "ask-result"; id: string; message: ChatMessage; result: AskQuestionResultSummary };
