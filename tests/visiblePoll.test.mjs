import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

const NativeEvent = Event;

async function withPolling(initialState, initialNative, run, options = {}) {
  await withHookHost(async ({ mount, load }) => {
    const doc = new EventTarget();
    doc.visibilityState = initialState;
    let time = 100;
    let nextTimer = 0;
    const timers = new Map();
    const window = {
      setTimeout(tick, delay) { const id = ++nextTimer; timers.set(id, { tick, due: time + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    };
    const nativeAtom = {};
    let nativeVisible = initialNative;
    let onNativeVisibility;
    const store = {
      get(atom) { assert.equal(atom, nativeAtom); return nativeVisible; },
      sub(atom, listener) {
        assert.equal(atom, nativeAtom);
        onNativeVisibility = listener;
        return () => { onNativeVisibility = undefined; };
      },
    };
    const { useVisiblePoll } = load("src/renderer/src/hooks/useVisiblePoll.ts", {
      globals: { document: doc, window, performance: { now: () => time }, Date: { now: () => { throw new Error("wall clock cannot drive poll deadlines"); } } },
      stubs: { jotai: { useStore: () => store }, "../atoms/window-visibility": { nativeWindowVisibleAtom: nativeAtom } },
    });
    const calls = [];
    const guards = [];
    const poll = await mount((props) => useVisiblePoll(props.scope, 1000,
      (cause, whenVisible) => { calls.push([props.scope, cause]); guards.push(whenVisible); }, props.immediate, options.refreshOnRestore), {
      scope: "repo", immediate: options.immediate ?? false,
    });
    const page = (state) => { doc.visibilityState = state; doc.dispatchEvent(new NativeEvent("visibilitychange")); };
    const native = (visible) => { nativeVisible = visible; onNativeVisibility?.(); };
    const advance = (elapsed) => {
      time += elapsed;
      for (const [id, timer] of timers) {
        if (timer.due > time) continue;
        timers.delete(id);
        timer.tick();
      }
    };
    await run({ calls, guards, poll, timers, page, native, advance });
  });
}

test("either hidden signal pauses polling, and restoring both refreshes once", async () => {
  await withPolling("visible", true, async ({ calls, poll, timers, page, native, advance }) => {
    assert.deepEqual(calls, [], "selection refresh already covers initial mount");
    advance(1000);
    native(false);
    assert.equal(timers.size, 0, "Qt minimize suspends work even when the page stays visible");
    advance(5000);
    page("hidden");
    native(true);
    assert.equal(timers.size, 0);
    page("visible");
    page("visible");
    assert.equal(timers.size, 1);
    assert.deepEqual(calls, [["repo", "interval"], ["repo", "visible"]]);
    await poll.unmount();
    native(false);
    page("hidden");
    native(true);
    page("visible");
    assert.equal(timers.size, 0);
  });
});

test("a first status read deferred by a hidden project switch keeps its initial-load semantics", async () => {
  await withPolling("visible", true, async ({ calls, poll, timers, native }) => {
    native(false);
    await poll.rerender({ scope: "other-repo", immediate: true });
    assert.equal(timers.size, 0);
    native(true);
    assert.deepEqual(calls, [["repo", "mount"], ["other-repo", "mount"]]);
    await poll.rerender({ scope: undefined });
    assert.equal(timers.size, 0);
  }, { immediate: true });
});

test("a deferred read belongs to one visible epoch and one mounted scope", async () => {
  await withPolling("visible", null, async ({ calls, guards, poll, native }) => {
    native(true);
    assert.deepEqual(calls, [], "the initial native snapshot is not a restore");
    native(false);
    native(true);
    const [first] = guards;
    assert.equal(first(), true);
    native(false);
    assert.equal(first(), false);
    native(true);
    assert.equal(first(), false, "a later restore must not revive a stale callback");
    const current = guards.at(-1);
    assert.equal(current(), true);
    await poll.rerender({ scope: "other-repo", immediate: false });
    assert.equal(current(), false);
  });
});

test("a remote fetch keeps its deadline through repeated visibility changes", async () => {
  await withPolling("visible", true, async ({ calls, native, advance }) => {
    for (let i = 0; i < 4; i++) {
      native(false);
      advance(100);
      native(true);
      advance(100);
    }
    assert.deepEqual(calls, [["repo", "mount"]]);
    native(false);
    advance(500);
    assert.deepEqual(calls, [["repo", "mount"]]);
    native(true);
    assert.deepEqual(calls, [["repo", "mount"], ["repo", "visible"]]);
  }, { immediate: true, refreshOnRestore: false });
});
