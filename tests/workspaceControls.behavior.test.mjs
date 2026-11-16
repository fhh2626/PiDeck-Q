import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

const translations = { t: (key) => key };
const buttons = (host) => Array.from(host.window.document.querySelectorAll("button"));
const byLabel = (host, label) => buttons(host).find((button) => button.getAttribute("aria-label") === label);
const click = (host, button) => host.act(async () => button.dispatchEvent(new host.window.Event("click", { bubbles: true })));

test("workspace controls preserve sidebar restoration, drawer state and explicit split exit", async () => withHookHost(async (host) => {
  const { WorkspaceToolbar } = host.load("src/renderer/src/components/workspace/WorkspaceToolbar.tsx", {
    stubs: { "../../i18n": translations, "@/lib/utils": host.load("src/renderer/src/lib/utils.ts") },
  });
  const calls = [];
  let props = { listCollapsed: true, drawerOpen: false,
    onToggleListCollapsed: () => calls.push("sidebar"), onToggleDrawer: () => calls.push("drawer"),
    onExitAllSplit: () => calls.push("split") };
  const mounted = await host.mount(() => undefined, {}, () => host.React.createElement(WorkspaceToolbar, props));
  await click(host, byLabel(host, "app.expandList"));
  await click(host, byLabel(host, "app.expandDrawer"));
  await click(host, byLabel(host, "session.split.exitAll"));
  assert.deepEqual(calls, ["sidebar", "drawer", "split"]);
  assert.equal(host.window.document.querySelector('[role="tab"]'), null);
  assert.equal(byLabel(host, "app.expandDrawer").getAttribute("aria-expanded"), "false");
  props = { ...props, listCollapsed: false, drawerOpen: true, onExitAllSplit: undefined };
  await mounted.rerender({});
  assert.equal(byLabel(host, "app.expandList"), undefined);
  assert.equal(byLabel(host, "session.split.exitAll"), undefined);
  assert.equal(byLabel(host, "app.collapseDrawer").getAttribute("aria-expanded"), "true");
}));

async function headerFixture(host, props) {
  const { SessionHeader } = host.load("src/renderer/src/components/session/SessionHeader.tsx", {
    stubs: {
      "../../i18n": translations,
      "@/lib/utils": host.load("src/renderer/src/lib/utils.ts"),
      "./SurfaceParts": { SessionStatus: () => null },
      "../../hooks/useSessionTimelineController": { isUserFacingSessionStart: () => false },
    },
  });
  let current = props;
  const mounted = await host.mount(() => undefined, {}, () => host.React.createElement(SessionHeader, current));
  return { async update(next) { current = next; await mounted.rerender({}); } };
}

test("a solo session retains its identity and never offers runtime controls without a bound Agent", async () => withHookHost(async (host) => {
  await headerFixture(host, { headerRef: { current: null }, title: "Draft session", projectName: "Project A", isStarting: false });
  assert.match(host.window.document.body.textContent, /Project A/);
  assert.match(host.window.document.body.textContent, /Draft session/);
  assert.equal(byLabel(host, "session.stopAgent"), undefined);
  assert.equal(byLabel(host, "app.restart"), undefined);
}));

test("pane runtime buttons call their own actions and remain disabled during restart", async () => withHookHost(async (host) => {
  const calls = [];
  const props = { headerRef: { current: null }, title: "Other pane", isStarting: false,
    canStop: false, onStop: () => calls.push("stop-other"), onRestart: () => calls.push("restart-other"),
    onExitSplit: () => calls.push("expand-other") };
  const fixture = await headerFixture(host, props);
  assert.equal(byLabel(host, "session.stopAgent").disabled, true);
  assert.equal(byLabel(host, "app.restart").disabled, false);
  await click(host, byLabel(host, "app.restart"));
  await click(host, byLabel(host, "session.split.exit"));
  assert.deepEqual(calls, ["restart-other", "expand-other"]);
  await fixture.update({ ...props, canStop: true, isRestarting: true });
  assert.equal(byLabel(host, "session.stopAgent").disabled, true);
  assert.equal(byLabel(host, "app.restarting").disabled, true);
  await fixture.update({ ...props, canStop: true, isRestarting: false });
  await click(host, byLabel(host, "session.stopAgent"));
  assert.deepEqual(calls, ["restart-other", "expand-other", "stop-other"]);
}));
