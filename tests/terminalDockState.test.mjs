import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

function compile(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (id) => imports[id] ?? {},
  });
  return module.exports;
}

function loadTerminalDockStateModule() {
  return compile("src/renderer/src/terminalDockState.ts");
}

function assertMotion(state, expected) {
  assert.equal(state.mounted, expected.mounted);
  assert.equal(state.closing, expected.closing);
  assert.equal(state.agentId, expected.agentId);
}

function loadDockMotion() {
  return compile("src/renderer/src/components/session/SessionRuntimeDock.tsx", {
    react: {},
    "react/jsx-runtime": { jsx: () => null },
    "../terminal/TerminalDock": {},
  });
}

test("remembers collapsed terminal dock state for each agent", () => {
  const { setTerminalDockCollapsed } = loadTerminalDockStateModule();
  const current = {
    agentA: { open: true, collapsed: false },
    agentB: { open: true, collapsed: false },
  };
  const next = setTerminalDockCollapsed(current, "agentA", true);
  assert.equal(next.agentA.collapsed, true);
  assert.equal(next.agentA.open, true);
  assert.equal(next.agentB.collapsed, false);
});

test("preserves collapsed state when toggling terminal open state", () => {
  const { setTerminalDockOpen } = loadTerminalDockStateModule();
  const closed = setTerminalDockOpen({ agentA: { open: true, collapsed: true } }, "agentA", false);
  const reopened = setTerminalDockOpen(closed, "agentA", true);
  assert.equal(closed.agentA.open, false);
  assert.equal(reopened.agentA.collapsed, true);
});

test("prunes agent and project keys against their own live sets", () => {
  const { pruneTerminalDockState, terminalOwnerKey } = loadTerminalDockStateModule();
  const agentA = terminalOwnerKey({ kind: "agent", id: "agentA" });
  const agentB = terminalOwnerKey({ kind: "agent", id: "agentB" });
  const projectP = terminalOwnerKey({ kind: "project", id: "projP" });
  const current = {
    [agentA]: { open: true, collapsed: true },
    [agentB]: { open: true, collapsed: false },
    [projectP]: { open: true, collapsed: false },
  };

  // 关键回归：不能用 agent 集合误删 project 键
  const next = pruneTerminalDockState(
    current,
    new Set(["agentB"]),
    new Set(["projP"]),
  );

  assert.equal(next[agentA], undefined);
  assert.equal(next[agentB].open, true);
  assert.equal(next[projectP].open, true);
});

test("streaming prune preserves canonical agent state without allocating a new state object", () => {
  const { pruneTerminalDockState, terminalOwnerKey } = loadTerminalDockStateModule();
  const agentId = "streaming-agent";
  const ownerKey = terminalOwnerKey({ kind: "agent", id: agentId });
  const current = { [ownerKey]: { open: true, collapsed: false } };

  // 流式 runtime-state 更新会反复触发 prune；存活 agent 的终端不能被清掉，
  // 且不应创建新对象触发额外 React 更新。
  const next = pruneTerminalDockState(current, new Set([agentId]), new Set());
  assert.strictEqual(next, current);
  assert.equal(next[ownerKey].open, true);

  // 兼容已运行实例：旧 hook 曾把 agentId 直接当 key 写入；流式 prune 时应迁移，
  // 不能把当前已打开的终端直接删掉。
  const legacy = { [agentId]: { open: true, collapsed: false } };
  const migrated = pruneTerminalDockState(legacy, new Set([agentId]), new Set());
  assert.notStrictEqual(migrated, legacy);
  assert.equal(migrated[agentId], undefined);
  assert.equal(migrated[ownerKey].open, true);

  // 如果热更新期间两种 key 同时存在，已写入的新 canonical 状态优先。
  const duplicate = {
    [agentId]: { open: false, collapsed: true },
    [ownerKey]: { open: true, collapsed: false },
  };
  const normalized = pruneTerminalDockState(duplicate, new Set([agentId]), new Set());
  assert.equal(normalized[agentId], undefined);
  assert.equal(normalized[ownerKey].open, true);
  assert.equal(normalized[ownerKey].collapsed, false);
});

/** 手动推进的 window.setTimeout 替身：Dock 关闭动画计时器由测试确定性触发。 */
function installFakeTimers(window) {
  const timers = new Map();
  let nextId = 1;
  window.setTimeout = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { fn, ms });
    return id;
  };
  window.clearTimeout = (id) => void timers.delete(id);
  return {
    pending: () => timers.size,
    async fire(host) {
      await host.act(async () => {
        const due = [...timers.values()];
        timers.clear();
        for (const timer of due) timer.fn();
      });
    },
  };
}

const AGENT_A = { kind: "agent", id: "A" };
const AGENT_B = { kind: "agent", id: "B" };
const PROJECT_P = { kind: "project", id: "P" };

// 为了向探针传入 owner，mount 的 props 即 hook 的参数
async function mountWith(host) {
  const timers = installFakeTimers(host.window);
  const { useTerminalDock } = host.load("src/renderer/src/hooks/useTerminalDock.ts");
  const mounted = await host.mount((owner) => useTerminalDock(owner), AGENT_A);
  return { timers, mounted };
}

test("terminal dock hook isolates open state per owner key", async () => {
  await withHookHost(async (host) => {
    const { mounted } = await mountWith(host);
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    assert.equal(mounted.result().terminalOpen, true);

    // agent B 与 project P 不共享 agent A 的开关；agent 与 project 的 id 即使相同也不串台
    await mounted.rerender(AGENT_B);
    assert.equal(mounted.result().terminalOpen, false);
    await mounted.rerender({ kind: "project", id: "A" });
    assert.equal(mounted.result().terminalOpen, false);

    await mounted.rerender(AGENT_A);
    assert.equal(mounted.result().terminalOpen, true);
  });
});

test("terminal dock hook remembers collapsed state per owner and preserves it across close/reopen", async () => {
  await withHookHost(async (host) => {
    const { mounted } = await mountWith(host);
    await host.act(async () => {
      mounted.result().setTerminalOpenForOwner(true);
      mounted.result().setTerminalCollapsedForOwner(true);
    });
    assert.equal(mounted.result().terminalCollapsed, true);

    await mounted.rerender(PROJECT_P);
    assert.equal(mounted.result().terminalCollapsed, false);
    // project P 自己的折叠状态写到它自己的 key，不影响 agent A
    await host.act(async () => mounted.result().setTerminalCollapsedForOwner(true));
    assert.equal(mounted.result().terminalCollapsed, true);
    await mounted.rerender(AGENT_B);
    assert.equal(mounted.result().terminalCollapsed, false);

    await mounted.rerender(AGENT_A);
    await host.act(async () => mounted.result().setTerminalCollapsedForOwner(false));
    await mounted.rerender(PROJECT_P);
    assert.equal(mounted.result().terminalCollapsed, true, "A 展开不得影响 P 的折叠状态");

    await mounted.rerender(AGENT_A);
    await host.act(async () => mounted.result().setTerminalCollapsedForOwner(true));
    await host.act(async () => mounted.result().setTerminalOpenForOwner(false));
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    assert.equal(mounted.result().terminalCollapsed, true);
  });
});

test("terminal dock hook ignores open/collapse commands when there is no owner", async () => {
  await withHookHost(async (host) => {
    const { mounted } = await mountWith(host);
    await mounted.rerender(undefined);
    await host.act(async () => {
      mounted.result().setTerminalOpenForOwner(true);
      mounted.result().setTerminalCollapsedForOwner(true);
    });
    assert.equal(mounted.result().terminalOpen, false);
    // 没有写坏 key：之后切回任意 owner 也不是打开状态
    await mounted.rerender(AGENT_A);
    assert.equal(mounted.result().terminalOpen, false);
    assert.equal(mounted.result().terminalCollapsed, false);
  });
});

test("terminal dock hook keeps terminal height per owner key", async () => {
  await withHookHost(async (host) => {
    const { mounted } = await mountWith(host);
    assert.equal(mounted.result().terminalRowHeight, 220);
    await host.act(async () =>
      mounted.result().setTerminalHeightByOwner((current) => ({ ...current, "agent:A": 333 })),
    );
    assert.equal(mounted.result().terminalRowHeight, 333);

    // 项目终端高度不与 agent 终端互相覆盖
    await mounted.rerender(PROJECT_P);
    assert.equal(mounted.result().terminalRowHeight, 220);
    await host.act(async () =>
      mounted.result().setTerminalHeightByOwner((current) => ({ ...current, "project:P": 150 })),
    );
    assert.equal(mounted.result().terminalRowHeight, 150);
    await mounted.rerender(AGENT_A);
    assert.equal(mounted.result().terminalRowHeight, 333);
  });
});

test("terminal dock hook prune checks agent and project keys against their own live sets", async () => {
  await withHookHost(async (host) => {
    const { mounted } = await mountWith(host);
    // 打开 agent A 与 project P 的终端并各设一份高度
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    await mounted.rerender(PROJECT_P);
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    await host.act(async () =>
      mounted.result().setTerminalHeightByOwner(() => ({ "agent:A": 300, "project:P": 160 })),
    );

    // 流式事件只更新 agent 集合（A 已消失，project P 仍存活）：project 终端必须保留
    await host.act(async () => mounted.result().prune(new Set(), new Set(["P"])));
    assert.equal(mounted.result().terminalOpen, true);
    assert.equal(mounted.result().terminalRowHeight, 160);

    // agent A 的开关与高度已被清掉
    await mounted.rerender(AGENT_A);
    assert.equal(mounted.result().terminalOpen, false);
    assert.equal(mounted.result().terminalRowHeight, 220);

    // 反向：project 消失、agent 存活
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    await host.act(async () => mounted.result().prune(new Set(["A"]), new Set()));
    assert.equal(mounted.result().terminalOpen, true);
    await mounted.rerender(PROJECT_P);
    assert.equal(mounted.result().terminalOpen, false);
  });
});

test("terminal dock hook unmounts the dock immediately when switching to an owner that is not open", async () => {
  await withHookHost(async (host) => {
    const { mounted, timers } = await mountWith(host);
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    assert.equal(mounted.result().terminalDockVisible, true);

    // 旧 owner 的关闭动画不得带到新上下文：立即卸载，且没有遗留计时器
    await mounted.rerender(AGENT_B);
    assert.equal(mounted.result().terminalDockVisible, false);
    assert.equal(mounted.result().terminalDockMounted, false);
    assert.equal(mounted.result().terminalDockClosing, false);
    assert.equal(timers.pending(), 0);
  });
});

test("terminal dock hook keeps the dock mounted through the close animation then unmounts it", async () => {
  await withHookHost(async (host) => {
    const { mounted, timers } = await mountWith(host);
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    await host.act(async () => mounted.result().setTerminalOpenForOwner(false));
    assert.equal(mounted.result().terminalDockClosing, true);
    assert.equal(mounted.result().terminalDockMounted, true);
    assert.equal(timers.pending(), 1);

    await timers.fire(host);
    assert.equal(mounted.result().terminalDockMounted, false);
    assert.equal(mounted.result().terminalDockClosing, false);
  });
});

test("terminal dock hook cancels the pending close timer when reopened mid-animation", async () => {
  await withHookHost(async (host) => {
    const { mounted, timers } = await mountWith(host);
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    await host.act(async () => mounted.result().setTerminalOpenForOwner(false));
    assert.equal(timers.pending(), 1);
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    assert.equal(timers.pending(), 0, "重开必须清掉关闭计时器，不能留第二个计时器 owner");
    assert.equal(mounted.result().terminalDockClosing, false);
    assert.equal(mounted.result().terminalDockVisible, true);
  });
});
test("terminal dock hook clears its pending close timer on unmount", async () => {
  await withHookHost(async (host) => {
    const { mounted, timers } = await mountWith(host);
    await host.act(async () => mounted.result().setTerminalOpenForOwner(true));
    await host.act(async () => mounted.result().setTerminalOpenForOwner(false));
    assert.equal(timers.pending(), 1);
    await mounted.unmount();
    assert.equal(timers.pending(), 0, "卸载后不得遗留关闭动画计时器");
  });
});
test("rapid reopen cancels the closing state without a second timer owner", () => {
  const { transitionSessionRuntimeDock } = loadDockMotion();
  const open = transitionSessionRuntimeDock({ mounted: false, closing: false }, { agentId: "A", open: true });
  const closing = transitionSessionRuntimeDock(open, { agentId: "A", open: false });
  const reopened = transitionSessionRuntimeDock(closing, { agentId: "A", open: true });
  assertMotion(closing, { mounted: true, closing: true, agentId: "A" });
  assertMotion(reopened, { mounted: true, closing: false, agentId: "A" });
});

test("runtime replacement mounts B directly and close completion cannot retain stale A", () => {
  const { transitionSessionRuntimeDock, finishSessionRuntimeDockClose, disposeSessionRuntimeDock } = loadDockMotion();
  const agentB = transitionSessionRuntimeDock(
    { mounted: true, closing: false, agentId: "A" }, { agentId: "B", open: true },
  );
  const closed = finishSessionRuntimeDockClose(
    transitionSessionRuntimeDock(agentB, { agentId: undefined, open: false }),
  );
  assertMotion(agentB, { mounted: true, closing: false, agentId: "B" });
  assertMotion(closed, { mounted: false, closing: false, agentId: undefined });
  assertMotion(disposeSessionRuntimeDock(), { mounted: false, closing: false, agentId: undefined });
});
