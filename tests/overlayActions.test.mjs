import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync("src/renderer/src/hooks/useOverlayActions.ts", "utf8");

function compileHook(reactStub) {
  const modules = new Map();
  function compile(path) {
    if (modules.has(path)) return modules.get(path);
    const output = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: path,
    }).outputText;
    const module = { exports: {} };
    modules.set(path, module.exports);
    vm.runInNewContext(output, {
      module, exports: module.exports,
      require: (specifier) => {
        if (specifier === "react") return reactStub;
        if (specifier === "./useConfirmationQueue") return compile("src/renderer/src/hooks/useConfirmationQueue.ts");
        if (specifier === "../utils/confirmationQueue") return compile("src/renderer/src/utils/confirmationQueue.ts");
        throw new Error(`Unexpected dependency ${specifier}`);
      },
    }, { filename: path });
    return module.exports;
  }
  return compile("src/renderer/src/hooks/useOverlayActions.ts");
}

function createOverlayActionsHarness() {
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
    useRef(initial) {
      const index = cursor++;
      states[index] ??= { current: initial };
      return states[index];
    },
    useEffect(effect) {
      const index = cursor++;
      if (!states[index]) states[index] = { cleanup: effect() };
    },
    useMemo(factory) {
      cursor++;
      return factory();
    },
  };
  const hooks = compileHook(react);
  function render() {
    cursor = 0;
    return hooks.useOverlayActions();
  }
  return { render, states };
}

test("useOverlayActions exposes confirmation state without a project trust gate", () => {
  const harness = createOverlayActionsHarness();
  const r = harness.render();
  r.showConfirm({ title: "X", message: "Y", onConfirm: () => undefined });

  const r2 = harness.render();
  assert.equal(r2.confirmDialog.title, "X");
  assert.deepEqual(Object.keys(r2.overlayProps), ["confirm"]);
  assert.deepEqual(Object.keys(r2).sort(), [
    "clearConfirm",
    "confirmDialog",
    "overlayProps",
    "showConfirm",
  ]);
});

test("useOverlayActions has no feedback / homepage / external-link overlay code", () => {
  // 文本匹配合理：这是“已移除功能不得回归”的静态规则，无运行时入口可断言。
  assert.doesNotMatch(source, /feedback|homepage|openExternal/);
});

test("showConfirm retains config and confirms at most once", () => {
  const harness = createOverlayActionsHarness();
  let confirmations = 0;
  const onConfirm = () => { confirmations++; };

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
  r2.confirmDialog.onConfirm();
  r2.confirmDialog.onConfirm();
  assert.equal(confirmations, 1);
  assert.equal(harness.render().confirmDialog, null);
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

test("overlayProps.confirm exposes config and a functioning once-only action", () => {
  const harness = createOverlayActionsHarness();
  let confirmations = 0;
  const onConfirm = () => { confirmations++; };

  const r = harness.render();
  assert.equal(r.overlayProps.confirm, undefined);
  r.showConfirm({ title: "Delete?", message: "Are you sure?", onConfirm, danger: true, confirmLabel: "Delete" });

  const r2 = harness.render();
  const c = r2.overlayProps.confirm;
  assert.equal(c.open, true);
  assert.equal(c.props.title, "Delete?");
  assert.equal(c.props.message, "Are you sure?");
  c.props.onConfirm();
  c.props.onConfirm();
  assert.equal(confirmations, 1);
  assert.equal(harness.render().overlayProps.confirm, undefined);
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
