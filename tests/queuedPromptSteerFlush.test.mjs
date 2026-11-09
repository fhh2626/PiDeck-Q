import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import { atom, createStore } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { PromptDeliveryUnknownError } from "../src/renderer/src/utils/promptErrors.ts";

/**
 * 忙碌期 steer 投递的串行策略回归测试。
 *
 * 背景：pi 在 run 收尾阶段仍会 accept 新的 steer，但 agent loop 已退出，
 * 消息要等下一次 run 才被消费。若把整批排队消息一次性塞给 pi，用户看到的是
 * 「多条消息一次性发出去，只有第一条生效」。这里锁住「每个窗口只投递队首一条」。
 */

const SESSION_ID = "s1";
const AGENT_ID = "a1";

function steerPrompt(id) {
  return {
    id,
    message: `expanded:${id}`,
    displayText: id,
    behavior: "steer",
    agentMode: "normal",
    timestamp: 1,
    status: "pending",
  };
}

/** 挂载真实 hook，返回最新 API 引用与 dispatch 调用记录。 */
async function withQueuedPrompt(run) {
  const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: new URL("http://localhost/"),
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  let root;
  try {
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const { createRoot } = await import("react-dom/client");
    root = createRoot(window.document.getElementById("root"));

    const store = createStore();
    const runtimeAtom = atom({
      [SESSION_ID]: {
        agentId: AGENT_ID,
        status: "running",
        state: { isStreaming: true, isExecutingTool: true },
      },
    });
    const module = loadTsCommonJs("src/renderer/src/hooks/useQueuedPrompt.ts", {
      // 生产代码用 window.setTimeout 做空闲补发延迟；VM 里没有 window，需显式注入。
      globals: { window },
      stubs: {
        "../atoms": {
          currentSessionIdAtom: atom(null),
          sessionRuntimeByIdAtom: runtimeAtom,
        },
        "../atoms/composer-atoms": {
          sessionDraftByIdAtom: atom({}),
          setSessionDraftAtom: atom(null, () => {}),
          setSessionAttachmentsAtom: atom(null, () => {}),
          setSessionComposerModeAtom: atom(null, () => {}),
        },
        "../i18n": { t: (key) => key },
        // 与用例共用同一个错误类，否则跨 realm 的 instanceof 判断会失效。
        "../utils/promptErrors": { PromptDeliveryUnknownError },
      },
    });

    const dispatched = [];
    const toasts = [];
    const apiRef = { current: undefined };
    // dispatch 实现可在用例内替换（hook 在渲染时捕获 options，替换后无需重渲染）。
    let dispatchImpl = async (sessionId, message) => {
      dispatched.push({ sessionId, message });
    };
    const options = {
      displayAgentsRef: { current: [{ id: AGENT_ID, status: "running" }] },
      queueFlushBySessionRef: { current: new Set() },
      composerTextareaRef: { current: null },
      pendingComposerCaretRef: { current: null },
      store,
      setComposerCursor: () => {},
      showToast: (message, duration) => toasts.push({ message, duration }),
      unknownDeliveryMessage: "delivery-unknown",
      dispatchPromptSnapshot: (sessionId, message, ...rest) =>
        dispatchImpl(sessionId, message, ...rest),
    };

    function Harness() {
      apiRef.current = module.useQueuedPrompt(options);
      return React.createElement("span", null, "queued");
    }

    await act(() => root.render(React.createElement(Harness)));
    await run({
      api: () => apiRef.current,
      dispatched,
      toasts,
      setDispatch: (impl) => { dispatchImpl = impl; },
      /** 模拟 agent 跑完：运行态与 agent 状态一起回到 idle。 */
      settleRuntime: () => {
        store.set(runtimeAtom, {
          [SESSION_ID]: { agentId: AGENT_ID, status: "idle", state: {} },
        });
        options.displayAgentsRef.current = [{ id: AGENT_ID, status: "idle" }];
      },
    });
  } finally {
    if (root) await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("flushQueuedSteerPrompts dispatches only the queue head per tool-end window", async () => {
  await withQueuedPrompt(async ({ api, dispatched }) => {
    for (const id of ["p1", "p2", "p3"]) {
      assert.equal(api().enqueueQueuedPrompt(SESSION_ID, steerPrompt(id)), true);
    }

    await act(async () => {
      await api().flushQueuedSteerPrompts(SESSION_ID);
    });

    assert.deepEqual(
      dispatched.map((call) => call.message),
      ["expanded:p1"],
      "only one steer may enter pi per window",
    );
    assert.deepEqual(
      [...api().queuedPrompts[SESSION_ID]].map((prompt) => prompt.id),
      ["p2", "p3"],
      "the remaining messages stay in the local queue so the user can still retract them",
    );
  });
});

test("each later tool-end window advances the queue by exactly one steer", async () => {
  await withQueuedPrompt(async ({ api, dispatched }) => {
    for (const id of ["p1", "p2", "p3"]) {
      api().enqueueQueuedPrompt(SESSION_ID, steerPrompt(id));
    }

    await act(async () => {
      await api().flushQueuedSteerPrompts(SESSION_ID);
    });
    await act(async () => {
      await api().flushQueuedSteerPrompts(SESSION_ID);
    });

    assert.deepEqual(
      dispatched.map((call) => call.message),
      ["expanded:p1", "expanded:p2"],
    );
    assert.deepEqual(
      [...api().queuedPrompts[SESSION_ID]].map((prompt) => prompt.id),
      ["p3"],
    );
  });
});

test("unknown steer delivery marks only the claimed prompt and blocks the rest", async () => {
  await withQueuedPrompt(async ({ api, dispatched, toasts, setDispatch }) => {
    setDispatch(async () => {
      throw new PromptDeliveryUnknownError("rpc timeout");
    });
    for (const id of ["p1", "p2"]) {
      api().enqueueQueuedPrompt(SESSION_ID, steerPrompt(id));
    }

    await act(async () => {
      await api().flushQueuedSteerPrompts(SESSION_ID);
    });
    await act(async () => {
      await api().flushQueuedSteerPrompts(SESSION_ID);
    });

    assert.deepEqual(dispatched, [], "a rejected dispatch must not send anything");
    assert.deepEqual(
      [...api().queuedPrompts[SESSION_ID]].map((prompt) => prompt.id),
      ["p1", "p2"],
    );
    assert.equal(api().queuedPrompts[SESSION_ID][0].status, "unknown");
    assert.equal(api().queuedPrompts[SESSION_ID][1].status, "pending");
    assert.deepEqual(
      toasts.map((toast) => toast.message),
      ["delivery-unknown"],
      "the unknown delivery is surfaced once, not once per queued message",
    );
  });
});

test("the remaining queue drains only after the agent settles", async () => {
  await withQueuedPrompt(async ({ api, dispatched, settleRuntime }) => {
    for (const id of ["p1", "p2"]) {
      api().enqueueQueuedPrompt(SESSION_ID, steerPrompt(id));
    }

    await act(async () => {
      await api().flushQueuedSteerPrompts(SESSION_ID);
    });
    assert.deepEqual(
      dispatched.map((call) => call.message),
      ["expanded:p1"],
      "a busy agent must not receive the rest of the queue",
    );

    settleRuntime();
    // finally 里的空闲补发延迟 150ms；轮询等它落地，避免固定 sleep 在慢机器上抖动。
    await act(async () => {
      const deadline = Date.now() + 2000;
      while (dispatched.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });

    assert.deepEqual(
      dispatched.map((call) => call.message),
      ["expanded:p1", "expanded:p2"],
      "the tail of the queue is delivered once the agent is idle",
    );
    assert.equal(api().queuedPrompts[SESSION_ID], undefined);
  });
});
