import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

const NativeEvent = Event;

test("a missed restore is recovered after repeated native snapshot failures", async () => {
  await withHookHost(async ({ mount, load, act }) => {
    const window = new EventTarget();
    const timers = new Map();
    let timerId = 0;
    window.setTimeout = (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; };
    window.clearTimeout = (id) => timers.delete(id);
    const outage = Array.from({ length: 6 }, () => new Error("transient timeout"));
    const snapshots = [false, ...outage, true, new Error("another timeout")];
    const app = {
      onWindowVisibilityChange: () => () => {},
      isWindowVisible: async () => {
        const next = snapshots.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    };
    const published = [];
    const publish = (visible) => published.push(visible);
    const { useNativeWindowVisibility } = load("src/renderer/src/hooks/useNativeWindowVisibility.ts", {
      globals: { window },
      stubs: {
        jotai: { useSetAtom: () => publish },
        "../atoms/window-visibility": { nativeWindowVisibleAtom: {} },
        "../native/initializeNativeDesktop": { NATIVE_EVENT_SNAPSHOT_INVALIDATED: "snapshot-invalidated" },
      },
    });
    const hook = await mount(() => useNativeWindowVisibility(true, app));
    const reconnect = () => act(async () => window.dispatchEvent(new NativeEvent("snapshot-invalidated")));
    await reconnect();
    for (const delay of [1000, 4000, 15000, 15000, 15000, 15000]) {
      assert.deepEqual(published, [false]);
      assert.equal(timers.size, 1, "keep a single recovery attempt scheduled after the cap");
      const [[id, retry]] = timers;
      assert.equal(retry.delay, delay);
      timers.delete(id);
      await act(async () => retry.fn());
    }
    assert.deepEqual(published, [false, true]);
    assert.equal(timers.size, 0);
    await reconnect();
    assert.equal(timers.size, 1);
    await hook.unmount();
    assert.equal(timers.size, 0);
  });
});

test("native visibility revalidates after a replay gap and ignores a superseded snapshot", async () => {
  await withHookHost(async ({ mount, load, act }) => {
    const window = new EventTarget();
    const snapshotInvalidated = "snapshot-invalidated";
    let onVisibility;
    const reads = [];
    const published = [];
    const app = {
      onWindowVisibilityChange(listener) {
        onVisibility = listener;
        return () => { onVisibility = undefined; };
      },
      isWindowVisible: () => new Promise((resolve) => reads.push(resolve)),
    };
    const { useNativeWindowVisibility } = load("src/renderer/src/hooks/useNativeWindowVisibility.ts", {
      globals: { window },
      stubs: {
        jotai: { useSetAtom: () => publish },
        "../atoms/window-visibility": { nativeWindowVisibleAtom: {} },
        "../native/initializeNativeDesktop": { NATIVE_EVENT_SNAPSHOT_INVALIDATED: snapshotInvalidated },
      },
    });
    function publish(visible) { published.push(visible); }
    const hook = await mount(() => useNativeWindowVisibility(true, app));
    await act(async () => reads.shift()(false));
    assert.deepEqual(published, [false]);

    onVisibility(true); // a historical show does not resume anything immediately
    window.dispatchEvent(new NativeEvent(snapshotInvalidated)); // gap/ready, even without a hide frame
    assert.equal(reads.length, 1, "coalesce revalidation while a snapshot is in flight");
    await act(async () => reads.shift()(true));
    assert.deepEqual(published, [false]);
    await act(async () => reads.shift()(false));
    assert.deepEqual(published, [false, false]);

    onVisibility(true); // live restore
    await act(async () => reads.shift()(true));
    assert.deepEqual(published, [false, false, true]);
    window.dispatchEvent(new NativeEvent(snapshotInvalidated));
    await hook.unmount();
    await act(async () => reads.shift()(false));
    assert.deepEqual(published, [false, false, true]);
    assert.equal(onVisibility, undefined);
    window.dispatchEvent(new NativeEvent(snapshotInvalidated));
    assert.equal(reads.length, 0);
  });
});
