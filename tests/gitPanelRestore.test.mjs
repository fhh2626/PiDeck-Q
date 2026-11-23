import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

async function withPanel(run) {
  await withHookHost(async ({ mount, load, act }) => {
    let tick;
    let visibleEpoch = 0;
    const groups = { merge: [], index: [], workingTree: [], untracked: [] };
    const reads = [];
    let completePush;
    const rerenderProps = {
      projectId: "a", currentBranch: "main", branches: ["main"],
      getStatus: (projectId) => new Promise((resolve) => reads.push({ projectId, resolve: () => resolve(groups) })),
      push: () => new Promise((resolve, reject) => {
        completePush = (error) => error ? reject(error) : resolve();
      }),
    };
    // The production polling hook is separately tested. Deliver its scoped
    // restore signal here with real GitPanel hooks and deferred status responses.
    const { GitPanel } = load("src/renderer/src/components/app/GitPanel.tsx", {
      stubs: {
        jotai: { useSetAtom: () => () => {} },
        "../../atoms": { settingsOpenAtom: {} },
        "../../hooks/useVisiblePoll": { useVisiblePoll: (scope, interval, onTick) => { if (interval === 15_000) tick = onTick; } },
        "../../i18n": { t: (key) => key },
        "../../utils/notice": { dismissNotice() {}, showNotice() {} },
        "../../utils/clipboard": {},
        "../../../../shared/types": { GitStatus: {} },
        "../ui-shadcn/button": { Button: "button" },
        "../ui-shadcn/context-menu": {},
        "./AppParts": {},
        "./git/GitResourceTree": { getCollapsibleChangeDirs: () => new Set() },
        "./git/GitPanelControls": {},
        "./git/GitGraph": {},
        "./git/floatingMenuPosition": {},
        "../ui-shadcn/input": { Input: "input" },
        "../ui-shadcn/textarea": { Textarea: "textarea" },
        "../../components/ui-shadcn/label": { Label: "label" },
      },
    });
    const panel = await mount(GitPanel, rerenderProps);
    const refresh = (cause) => act(async () => {
      const epoch = visibleEpoch;
      tick(cause, () => epoch === visibleEpoch);
    });
    const hide = () => { visibleEpoch++; };
    const finish = (i) => act(async () => reads[i].resolve());
    const select = (projectId) => panel.rerender({ ...rerenderProps, projectId });
    const find = (node, label) => {
      if (Array.isArray(node)) return node.map((child) => find(child, label)).find(Boolean);
      if (node?.props?.["aria-label"] === label) return node;
      return node?.props ? find(node.props.children, label) : undefined;
    };
    const push = () => act(async () => find(panel.result(), "git.push").props.onClick());
    const finishPush = (error) => act(async () => completePush(error));
    await run({ reads, refresh, hide, finish, select, push, finishPush });
  });
}

test("the Git drawer does one fresh status scan when the restore joins an older scan", async () => {
  await withPanel(async ({ reads, refresh, finish }) => {
    await refresh("mount");
    await refresh("visible");
    await refresh("visible");
    assert.equal(reads.length, 1, "no overlapping status scans");
    await finish(0);
    assert.deepEqual(reads.map((read) => read.projectId), ["a", "a"]);
    await finish(1);
    assert.equal(reads.length, 2);
  });
});

test("the restore scan waits for an in-progress mutation even if the mutation fails", async () => {
  await withPanel(async ({ reads, refresh, finish, push, finishPush }) => {
    await refresh("mount");
    await push();
    await refresh("visible");
    await finish(0);
    assert.equal(reads.length, 1, "don't scan while Git is mutating the worktree");
    await finishPush(new Error("push failed"));
    assert.equal(reads.length, 2, "a failed mutation must not discard the restore scan");
    await finish(1);
  });
});

test("the successful mutation's fresh scan covers the restore without another scan", async () => {
  await withPanel(async ({ reads, refresh, finish, push, finishPush }) => {
    await refresh("mount");
    await push();
    await refresh("visible");
    await finish(0);
    await finishPush();
    assert.equal(reads.length, 2);
    await finish(1);
    assert.equal(reads.length, 2);
  });
});

test("a queued drawer scan cannot run after the window hides or the project changes", async () => {
  await withPanel(async ({ reads, refresh, hide, finish, select }) => {
    await refresh("mount");
    await refresh("visible");
    hide();
    await finish(0);
    assert.equal(reads.length, 1);
    await refresh("visible");
    await refresh("visible");
    await select("b");
    await finish(1);
    assert.deepEqual(reads.map((read) => read.projectId), ["a", "a"]);
  });
});
