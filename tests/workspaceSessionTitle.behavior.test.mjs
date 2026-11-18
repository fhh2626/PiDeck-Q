import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

const require = createRequire(import.meta.url);
const { createStore, Provider } = require("jotai");

function record(id, projectId, title, extra = {}) {
  return { id, projectId, title, source: "pi", environment: "native", preview: "", messageCount: 1,
    status: "active", createdAt: 1, updatedAt: 1, filePath: "/sessions/" + id + ".jsonl", ...extra };
}

/** Retain the Popover open/close contract without depending on browser geometry. */
function popoverPrimitives(React) {
  const Context = React.createContext({ open: false, onOpenChange: () => undefined });
  return {
    Popover: ({ open = false, onOpenChange = () => undefined, children }) =>
      React.createElement(Context.Provider, { value: { open, onOpenChange } }, children),
    PopoverTrigger: ({ children }) => {
      const { open, onOpenChange } = React.useContext(Context);
      return React.cloneElement(children, { "aria-haspopup": "dialog", "aria-expanded": open,
        onClick: () => onOpenChange(!open) });
    },
    PopoverContent: ({ children }) => {
      const { open } = React.useContext(Context);
      return open ? React.createElement("div", { role: "dialog" }, children) : null;
    },
  };
}

async function click(host, element) {
  assert.ok(element, "the requested branch control exists");
  await host.act(async () => element.dispatchEvent(new host.window.Event("click", { bubbles: true })));
}

async function openMenu(host) {
  const trigger = host.window.document.querySelector('[aria-haspopup="dialog"]');
  await click(host, trigger);
  return host.window.document.querySelector('[role="dialog"]');
}

async function fixture(host, records, initialSessionId, onOpenSession = async () => undefined) {
  const atoms = host.load("src/renderer/src/atoms/index.ts");
  const store = createStore();
  store.set(atoms.sessionRecordsAtom, records);
  const errors = [];
  const { WorkspaceSessionTitle } = host.load("src/renderer/src/components/workspace/WorkspaceSessionTitle.tsx", {
    stubs: {
      "../../atoms/session-atoms": atoms,
      "../../atoms/session-selectors": atoms,
      "../../i18n": { t: (key, values) => values ? key + " " + JSON.stringify(values) : key },
      "@/lib/utils": host.load("src/renderer/src/lib/utils.ts"),
      "../ui-shadcn/popover": popoverPrimitives(host.React),
    },
  });
  let sessionId = initialSessionId;
  const mounted = await host.mount(() => undefined, {}, () => host.React.createElement(Provider, { store },
    host.React.createElement(WorkspaceSessionTitle, { sessionId, onOpenSession, onError: (message) => errors.push(message) })));
  return {
    errors,
    async select(id) { sessionId = id; await mounted.rerender({}); },
    async update(next) { await host.act(async () => store.set(atoms.sessionRecordsAtom, next)); },
  };
}

test("top title follows focused session and catalog renames, then clears on the project welcome page", async () => withHookHost(async (host) => {
  const records = { a: record("a", "p1", "First conversation"), b: record("b", "p2", "Second conversation") };
  const ui = await fixture(host, records, "a");
  assert.match(host.window.document.body.textContent, /First conversation/);
  await ui.select("b");
  assert.match(host.window.document.body.textContent, /Second conversation/);
  assert.doesNotMatch(host.window.document.body.textContent, /First conversation/);
  await ui.update({ ...records, b: { ...records.b, title: "Renamed conversation", updatedAt: 2 } });
  assert.equal(host.window.document.querySelector("[data-session-titlebar] span").getAttribute("title"), "Renamed conversation");
  await ui.select(null);
  assert.equal(host.window.document.querySelector("[data-session-titlebar]"), null);
}));

test("top branch controls show the count and navigate using the displayed session's project", async () => withHookHost(async (host) => {
  const records = {
    parent: record("parent", "p2", "Parent"),
    b1: record("b1", "p2", "First branch", { parentSessionId: "parent", createdAt: 2 }),
    b2: record("b2", "p2", "Second branch", { parentSessionId: "parent", createdAt: 3 }),
    child: record("child", "p2", "Child branch", { parentSessionId: "b1", createdAt: 4 }),
    unrelated: record("unrelated", "p1", "Other project's branch", { parentSessionId: "b1", createdAt: 5 }),
  };
  const opened = [];
  await fixture(host, records, "b1", async (projectId, sessionId) => { opened.push([projectId, sessionId]); });
  const titlebar = host.window.document.querySelector("[data-session-titlebar]");
  assert.equal(titlebar.querySelectorAll("button").length, 1, "all branch controls share one compact trigger");
  const trigger = titlebar.querySelector("button");
  assert.equal(trigger.textContent, "1/2");
  assert.match(trigger.getAttribute("title"), /branch\.parent \{"title":"Parent"\}/);
  assert.match(trigger.getAttribute("title"), /branch\.pager \{"index":1,"total":2\}/);
  assert.match(trigger.getAttribute("title"), /branch\.children \{"count":1\}/);
  assert.equal(trigger.getAttribute("aria-label"), trigger.getAttribute("title"));
  await openMenu(host);
  const previous = host.window.document.querySelector('[aria-label="branch.prev"]');
  const next = host.window.document.querySelector('[aria-label="branch.next"]');
  assert.equal(previous.disabled, true);
  await click(host, next);
  assert.deepEqual(opened, [["p2", "b2"]]);
  assert.equal(host.window.document.querySelector('[role="dialog"]'), null);

  await openMenu(host);
  await click(host, [...host.window.document.querySelectorAll("button")].find((button) => button.getAttribute("title") === 'branch.parent {"title":"Parent"}'));
  await openMenu(host);
  await click(host, host.window.document.querySelector('[title="Child branch"]'));
  await openMenu(host);
  await click(host, host.window.document.querySelector('[title="Second branch"]'));
  assert.deepEqual(opened, [["p2", "b2"], ["p2", "parent"], ["p2", "child"], ["p2", "b2"]]);
}));

test("branch navigation failures reach the existing user-facing error handler", async () => withHookHost(async (host) => {
  const records = {
    parent: record("parent", "p1", "Parent"),
    branch: record("branch", "p1", "Child", { parentSessionId: "parent", createdAt: 2 }),
  };
  const ui = await fixture(host, records, "branch", async () => { throw new Error("Session could not be opened"); });
  await openMenu(host);
  const button = host.window.document.querySelector('[role="dialog"] button');
  await click(host, button);
  assert.equal(ui.errors.length, 1);
  assert.match(ui.errors[0], /Session could not be opened/);
}));

test("compact branch counters cover child-only and single-parent families", async () => withHookHost(async (host) => {
  const records = {
    parent: record("parent", "p1", "Parent"),
    child: record("child", "p1", "Child", { parentSessionId: "parent", createdAt: 2 }),
    grandchild1: record("grandchild1", "p1", "Grandchild 1", { parentSessionId: "child", createdAt: 3 }),
    grandchild2: record("grandchild2", "p1", "Grandchild 2", { parentSessionId: "child", createdAt: 4 }),
  };
  const ui = await fixture(host, records, "parent");
  assert.equal(host.window.document.querySelector('[aria-haspopup="dialog"]').textContent, "1");
  await ui.select("child");
  assert.equal(host.window.document.querySelector('[aria-haspopup="dialog"]').textContent, "2");
  await ui.update({ parent: records.parent, child: records.child });
  assert.equal(host.window.document.querySelector('[aria-haspopup="dialog"]').textContent, "1");
}));

test("moving focus to another session closes the old branch menu", async () => withHookHost(async (host) => {
  const records = {
    parent: record("parent", "p1", "Parent"),
    b1: record("b1", "p1", "First", { parentSessionId: "parent", createdAt: 2 }),
    b2: record("b2", "p1", "Second", { parentSessionId: "parent", createdAt: 3 }),
  };
  const ui = await fixture(host, records, "b1");
  assert.ok(await openMenu(host));
  await ui.select("b2");
  assert.equal(host.window.document.querySelector('[role="dialog"]'), null);
  assert.equal(host.window.document.querySelector('[aria-haspopup="dialog"]').textContent, "2/2");
}));
