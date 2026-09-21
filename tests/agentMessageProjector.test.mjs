import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentMessageProjector, buildActiveBranchEntryIds } = loadTsCommonJs(
  "src/main/pi/AgentMessageProjector.ts",
  {
    stubs: {
      "./messageContent": {
        extractMessageText: (content) => Array.isArray(content)
          ? content
            .filter((item) => item?.type === "text")
            .map((item) => item.text ?? "")
            .join("\n")
          : typeof content === "string" ? content : "",
      },
      "./sessionEntryIds": {
        takeActiveEntryId: (ids, index) => ({
          entryId: ids?.[index],
          nextIndex: index + 1,
        }),
      },
    },
  },
);

function translate(key, params = {}) {
  if (key === "session.imagePlaceholder") return "[image]";
  if (key === "mainTool.truncated") return `[truncated ${params.omitted}/${params.total}]`;
  return key;
}

function createProjector(isAskAborted = () => false) {
  return new AgentMessageProjector({ translate, isAskAborted });
}

test("keeps thinking-only history turns and their entry IDs aligned", () => {
  const messages = createProjector().convert("agent", [
    { role: "user", content: [{ type: "text", text: "Inspect this" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "Check the history" }], timestamp: 2 },
    { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "file" }], timestamp: 3 },
  ], ["entry-user", "entry-thinking", "entry-tool"]);

  assert.deepEqual(messages.map((message) => message.meta.entryId), [
    "entry-user",
    "entry-thinking",
    "entry-tool",
  ]);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].text, "");
  assert.equal(messages[1].thinking, "Check the history");
});

test("restores image-only history messages with a localized placeholder", () => {
  const messages = createProjector().convert("agent", [{
    role: "user",
    content: [{ type: "image", data: "YmFzZTY0LWRhdGE=", mime_type: "image/jpeg" }],
    timestamp: 1,
  }], ["entry-image"]);

  assert.equal(messages[0].text, "[image]");
  assert.equal(messages[0].images.length, 1);
  assert.equal(messages[0].images[0].type, "image");
  assert.equal(messages[0].images[0].data, "YmFzZTY0LWRhdGE=");
  assert.equal(messages[0].images[0].mimeType, "image/jpeg");
  assert.equal(messages[0].meta.entryId, "entry-image");
});

test("restores tool arguments while bounding retained historical output", () => {
  const hugeResult = `${"a".repeat(9_000)}\nEND-MARKER`;
  const messages = createProjector().convert("agent", [
    {
      role: "assistant",
      timestamp: 10,
      content: [{
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: { path: "src/app.ts", content: "export const answer = 42;" },
      }],
    },
    {
      role: "toolResult",
      toolCallId: "write-1",
      content: [{ type: "text", text: hugeResult }],
      timestamp: 25,
    },
  ], ["entry-call", "entry-result"]);

  const toolMessage = messages[0];
  assert.equal(toolMessage.meta.toolName, "write");
  assert.match(toolMessage.meta.args, /src\/app\.ts/);
  assert.ok(toolMessage.meta.result.length < 8_100);
  assert.match(toolMessage.meta.result, /^a+/);
  assert.match(toolMessage.meta.result, /END-MARKER$/);
  assert.equal(toolMessage.meta.durationMs, 15);
});

test("marks recovered ask_question cards unanswered when that agent was cancelled", () => {
  const messages = createProjector((agentId) => agentId === "cancelled-agent").convert("cancelled-agent", [
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "ask-1",
        name: "ask_question",
        arguments: { question: "Continue?" },
      }],
    },
    {
      role: "toolResult",
      toolCallId: "ask-1",
      content: [],
      details: {
        question: "Continue?",
        type: "confirm",
        answered: true,
        answer: true,
        answerLabel: "Yes",
      },
    },
  ], ["entry-call", "entry-result"]);

  assert.equal(messages[0].meta._askCard.question, "Continue?");
  assert.equal(messages[0].meta._askCard.type, "confirm");
  assert.equal(messages[0].meta._askCard.answered, false);
  assert.equal(messages[0].meta._askCard.answer, null);
  assert.equal(messages[0].meta._askCard.answerLabel, undefined);
  assert.equal(messages[0].meta._askCard.options, undefined);
});

test("restores a full batch ask_question with every question and its answer", () => {
  const messages = createProjector().convert("agent", [
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "ask-batch",
        name: "ask_question",
        arguments: {
          questions: [
            { question: "Runtime?", type: "select" },
            { question: "Package manager?", type: "select" },
            { question: "Extra?", type: "input" },
          ],
        },
      }],
    },
    {
      role: "toolResult",
      toolCallId: "ask-batch",
      content: [],
      details: {
        questions: [
          { question: "Runtime?", type: "select", options: ["node", "deno"] },
          { question: "Package manager?", type: "select", options: ["npm", "pnpm"] },
          { question: "Extra?", type: "input" },
        ],
        answers: [
          { id: "q1", type: "select", value: "deno", label: "deno" },
          { id: "q2", type: "select", value: "pnpm", label: "pnpm" },
          { id: "q3", type: "input", value: "custom text", label: "custom text" },
        ],
        cancelled: false,
      },
    },
  ], ["entry-call", "entry-result"]);

  const card = messages[0].meta._askCard;
  // 关键回归点：历史回放必须恢复全部三题，而不是只取第一题。
  assert.equal(card.questions.length, 3);
  // cross-realm prototypes make deepStrictEqual flaky under the VM loader.
  assert.equal(
    card.questions.map((item) => item.question).join("|"),
    "Runtime?|Package manager?|Extra?",
  );
  assert.equal(
    card.questions.map((item) => item.answer).join("|"),
    "deno|pnpm|custom text",
  );
  assert.equal(card.questions[0].options.join("|"), "node|deno");
  assert.equal(card.cancelled, false);
});

test("restores a cancelled batch ask_question with every question unanswered", () => {
  const messages = createProjector().convert("agent", [
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "ask-cancel",
        name: "ask_question",
        arguments: {
          questions: [
            { question: "A?", type: "select" },
            { question: "B?", type: "select" },
          ],
        },
      }],
    },
    {
      role: "toolResult",
      toolCallId: "ask-cancel",
      content: [],
      details: {
        questions: [{ question: "A?" }, { question: "B?" }],
        answers: [],
        cancelled: true,
      },
    },
  ], ["entry-call", "entry-result"]);

  const card = messages[0].meta._askCard;
  assert.equal(card.cancelled, true);
  assert.equal(card.questions.length, 2);
  assert.ok(card.questions.every((item) => item.answered === false && item.answer === null));
});

test("returns only message entries on the active branch", () => {
  const ids = buildActiveBranchEntryIds([
    { id: "session", parentId: null, type: "session" },
    { id: "message-1", parentId: "session", type: "message" },
    { id: "model", parentId: "message-1", type: "model_change" },
    { id: "message-2", parentId: "model", type: "message" },
    { id: "discarded", parentId: "message-1", type: "message" },
  ], "message-2");

  assert.deepEqual(Array.from(ids), ["message-1", "message-2"]);
});
