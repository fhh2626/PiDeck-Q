import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync("src/renderer/src/hooks/useOverlayActions.ts", "utf8");

function compileHook(reactStub, desktopApiStub) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "src/renderer/src/hooks/useOverlayActions.ts",
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "react") return reactStub;
      if (specifier === "../desktopApi") return desktopApiStub;
      return {};
    },
  }, { filename: "src/renderer/src/hooks/useOverlayActions.ts" });
  return module.exports;
}

function wrapDesktopApi(api) {
  return { desktopApi: api };
}

function createOverlayActionsHarness(desktopApiStub) {
  const states = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      states[index] ??= typeof initial === "function" ? initial() : initial;
      const setter = (next) => {
        states[index] = typeof next === "function" ? next(states[index]) : next;
      };
      return [states[index], setter];
    },
    useCallback(fn) {
      cursor++;
      return fn;
    },
    useMemo(factory) {
      cursor++;
      return factory();
    },
  };
  const hooks = compileHook(
    react,
    desktopApiStub ?? wrapDesktopApi({ projects: { respondTrustRequest: () => undefined } }),
  );
  function render() {
    cursor = 0;
    return hooks.useOverlayActions();
  }
  return { render, states };
}

test("useOverlayActions owns only confirm and trust state", () => {
  const harness = createOverlayActionsHarness();
  const r = harness.render();
  r.showConfirm({ title: "X", message: "Y", onConfirm: () => undefined });
  r.setTrustRequest({ requestId: "r1", cwd: "/tmp", projectName: "Test" });

  // 行为面：返回值只暴露 confirm / trust 两个域的状态与命令，
  // overlayProps 只可能出现 confirm / trust 两个浮层。
  const r2 = harness.render();
  // 命令确实改写了各自的状态（而不仅是 key 存在）。
  assert.equal(r2.confirmDialog.title, "X");
  assert.deepEqual({ ...r2.trustRequest }, { requestId: "r1", cwd: "/tmp", projectName: "Test" });
  assert.deepEqual(Object.keys(r2.overlayProps).sort(), ["confirm", "trust"]);
  assert.deepEqual(Object.keys(r2).sort(), [
    "clearConfirm",
    "confirmDialog",
    "overlayProps",
    "setTrustRequest",
    "showConfirm",
    "trustRequest",
  ]);
});

test("useOverlayActions has no feedback / homepage / external-link overlay code", () => {
  // 文本匹配合理：这是“已移除功能不得回归”的静态规则，无运行时入口可断言。
  assert.doesNotMatch(source, /feedback|homepage|openExternal/);
});

test("showConfirm sets confirmDialog with full config", () => {
  const harness = createOverlayActionsHarness();
  const onConfirm = () => undefined;

  const r = harness.render();
  r.showConfirm({
    title: "Delete?",
    message: "Are you sure?",
    onConfirm,
    danger: true,
    confirmLabel: "Delete",
  });

  const r2 = harness.render();
  assert.equal(r2.confirmDialog.title, "Delete?");
  assert.equal(r2.confirmDialog.message, "Are you sure?");
  assert.equal(r2.confirmDialog.onConfirm, onConfirm);
  assert.equal(r2.confirmDialog.danger, true);
  assert.equal(r2.confirmDialog.confirmLabel, "Delete");
});

test("clearConfirm sets confirmDialog to null", () => {
  const harness = createOverlayActionsHarness();
  const r = harness.render();
  r.showConfirm({ title: "X", message: "Y", onConfirm: () => undefined });

  const r2 = harness.render();
  assert.notEqual(r2.confirmDialog, null);
  r2.clearConfirm();

  const r3 = harness.render();
  assert.equal(r3.confirmDialog, null);
});

test("trustRequest set and get", () => {
  const harness = createOverlayActionsHarness();
  const req = { requestId: "r1", cwd: "/tmp", projectName: "Test" };

  const r = harness.render();
  assert.equal(r.trustRequest, null);
  r.setTrustRequest(req);

  const r2 = harness.render();
  assert.equal(r2.trustRequest.requestId, "r1");
  assert.equal(r2.trustRequest.cwd, "/tmp");
  assert.equal(r2.trustRequest.projectName, "Test");
});

test("overlayProps.confirm structure when confirmDialog is set", () => {
  const harness = createOverlayActionsHarness();
  const onConfirm = () => undefined;

  const r = harness.render();
  assert.equal(r.overlayProps.confirm, undefined);
  r.showConfirm({ title: "Delete?", message: "Are you sure?", onConfirm, danger: true, confirmLabel: "Delete" });

  const r2 = harness.render();
  const c = r2.overlayProps.confirm;
  assert.equal(c.open, true);
  assert.equal(c.props.title, "Delete?");
  assert.equal(c.props.message, "Are you sure?");
  assert.equal(c.props.onConfirm, onConfirm);
  assert.equal(c.props.danger, true);
  assert.equal(c.props.confirmLabel, "Delete");
});

test("overlayProps.confirm onCancel clears confirmDialog", () => {
  const harness = createOverlayActionsHarness();
  const r = harness.render();
  r.showConfirm({ title: "X", message: "Y", onConfirm: () => undefined });

  const r2 = harness.render();
  r2.overlayProps.confirm.props.onCancel();

  const r3 = harness.render();
  assert.equal(r3.confirmDialog, null);
  assert.equal(r3.overlayProps.confirm, undefined);
});

test("overlayProps.trust structure when trustRequest is set", () => {
  let trustChoice;
  const desktopApi = wrapDesktopApi({
    projects: {
      respondTrustRequest: (requestId, choice) => { trustChoice = { requestId, choice }; },
    },
  });
  const harness = createOverlayActionsHarness(desktopApi);

  const r = harness.render();
  assert.equal(r.overlayProps.trust, undefined);
  r.setTrustRequest({ requestId: "r1", cwd: "/tmp/proj", projectName: "Test" });

  const r2 = harness.render();
  const trust = r2.overlayProps.trust;
  assert.equal(trust.open, true);
  assert.equal(trust.requestId, "r1");
  assert.equal(trust.cwd, "/tmp/proj");
  assert.equal(trust.projectName, "Test");
  assert.equal(typeof trust.onChoose, "function");

  trust.onChoose("trust-remember");
  assert.deepEqual(trustChoice, { requestId: "r1", choice: "trust-remember" });

  const r3 = harness.render();
  assert.equal(r3.trustRequest, null);
  assert.equal(r3.overlayProps.trust, undefined);
});

test("overlayProps.trust onChoose supports all three trust choices", () => {
  const choices = [];
  const desktopApi = wrapDesktopApi({
    projects: {
      respondTrustRequest: (_requestId, choice) => choices.push(choice),
    },
  });
  const harness = createOverlayActionsHarness(desktopApi);

  const r = harness.render();
  r.setTrustRequest({ requestId: "r1", cwd: "/tmp", projectName: "T" });
  const r2 = harness.render();
  r2.overlayProps.trust.onChoose("trust-remember");

  r2.setTrustRequest({ requestId: "r2", cwd: "/tmp", projectName: "T" });
  const r3 = harness.render();
  r3.overlayProps.trust.onChoose("trust-session");

  r3.setTrustRequest({ requestId: "r3", cwd: "/tmp", projectName: "T" });
  const r4 = harness.render();
  r4.overlayProps.trust.onChoose("deny");

  assert.deepEqual(choices, ["trust-remember", "trust-session", "deny"]);
});

test("overlayProps combines confirm and trust overlays simultaneously", () => {
  const harness = createOverlayActionsHarness();
  const r = harness.render();
  r.showConfirm({ title: "Delete?", message: "Confirm delete", onConfirm: () => undefined });
  r.setTrustRequest({ requestId: "r1", cwd: "/tmp", projectName: "Test" });

  const r2 = harness.render();
  const props = r2.overlayProps;
  assert.equal(props.feedback, undefined);
  assert.equal(props.confirm.open, true);
  assert.equal(props.confirm.props.title, "Delete?");
  assert.equal(props.trust.open, true);
  assert.equal(props.trust.requestId, "r1");
});
