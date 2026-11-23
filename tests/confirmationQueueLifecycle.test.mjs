import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

// Real React state/effects exercise the queue owner, including unmount cleanup.
test("confirmation owner queues dialogs and fences stale confirm/cancel callbacks", async () => {
  await withHookHost(async ({ load, mount, act }) => {
    const { useConfirmationQueue } = load("src/renderer/src/hooks/useConfirmationQueue.ts");
    const owner = await mount(useConfirmationQueue, {});
    const choices = [];
    await act(async () => {
      owner.result().showConfirm({ title: "A", message: "A", onConfirm: () => {
        owner.result().clearConfirm(); choices.push("A");
      } });
      owner.result().showConfirm({ title: "B", message: "B", onConfirm: () => choices.push("B"), onCancel: () => choices.push("cancel B") });
    });
    const previous = owner.result().confirmDialog;
    assert.equal(previous.title, "A");
    await act(async () => { previous.onConfirm(); });
    assert.equal(owner.result().confirmDialog.title, "B");
    await act(async () => { previous.onConfirm(); previous.onCancel(); });
    assert.equal(owner.result().confirmDialog.title, "B");
    assert.deepEqual(choices, ["A"]);
    await act(async () => owner.result().confirmDialog.onCancel());
    assert.equal(owner.result().confirmDialog, null);
    assert.deepEqual(choices, ["A", "cancel B"]);
  });
});

test("confirmation owner unmount settles both visible and queued requests", async () => {
  await withHookHost(async ({ load, mount, act }) => {
    const { useConfirmationQueue } = load("src/renderer/src/hooks/useConfirmationQueue.ts");
    const owner = await mount(useConfirmationQueue, {});
    const cancelled = [];
    await act(async () => {
      for (const title of ["A", "B"]) owner.result().showConfirm({ title, message: title,
        onConfirm: () => assert.fail("Unmount must never authorize a destructive operation"),
        onCancel: () => cancelled.push(title) });
    });
    await owner.unmount();
    assert.deepEqual(cancelled, ["A", "B"]);
  });
});
