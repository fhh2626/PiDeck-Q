import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createManager(status = "idle") {
  const runtime = {
    tab: {
      id: "agent-1",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status,
      createdAt: 1,
    },
    process: {
      isRunning: () => true,
      client: {
        request: async (payload) => ({ success: true, data: { payload } }),
      },
    },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({ rpcTimeout: 30_000 }) },
    {},
    undefined,
    undefined,
    undefined,
    (key) => key,
  );
  manager.agents.set("agent-1", runtime);
  return { manager, runtime };
}

test("the host optimistic user message carries the renderer requestId", async () => {
  const { manager } = createManager();
  const result = await manager.sendPrompt({
    agentId: "agent-1",
    requestId: "request-1",
    message: "hello",
  });

  assert.equal(result.accepted, true);
  const user = manager.messages.get("agent-1").find((message) => message.role === "user");
  assert.equal(user?.meta?.optimisticRequestId, "request-1");
  assert.equal(user?.meta?.streamingBehavior, undefined);
});

test("a steer prompt keeps both the requestId and delivery semantics", async () => {
  const { manager } = createManager("running");
  await manager.sendPrompt({
    agentId: "agent-1",
    requestId: "request-2",
    message: "more",
  });

  const user = manager.messages.get("agent-1").find((message) => message.role === "user");
  assert.equal(user?.meta?.optimisticRequestId, "request-2");
  assert.equal(user?.meta?.streamingBehavior, "steer");
});

test("a prompt without a requestId does not invent one", async () => {
  const { manager } = createManager();
  await manager.sendPrompt({
    agentId: "agent-1",
    message: "hello",
  });

  const user = manager.messages.get("agent-1").find((message) => message.role === "user");
  assert.equal(user?.meta, undefined);
});

test("a ! command host user keeps the renderer requestId despite command normalization", async () => {
  const { manager } = createManager();
  await manager.sendPrompt({
    agentId: "agent-1",
    requestId: "request-bash",
    message: "!   ls",
  });

  const user = manager.messages.get("agent-1").find((message) => message.role === "user");
  assert.equal(user?.text, "!ls");
  assert.equal(user?.meta?.optimisticRequestId, "request-bash");
});
