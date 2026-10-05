import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withComposerReact } from "./helpers/composerReactHarness.mjs";

/** Mount the production measurement owner, including its actual effects and JSX. */
function loadExtras(h) {
  return loadTsCommonJs("src/renderer/src/components/session/composer/ComposerMeasuredExtras.tsx", {
    stubs: { react: h.React }, globals: h.globals,
  }).ComposerMeasuredExtras;
}

function slot(h, height) {
  return h.React.createElement("div", { "data-fixture-height": height });
}

test("unchanged extras do not synchronously measure on parent draft renders", async () => {
  await withComposerReact(async (h) => {
    const Extras = loadExtras(h);
    const reports = [];
    const render = () => h.root.render(h.React.createElement(Extras, {
      // Fresh ReactNodes simulate ComposerArea's actual per-render element creation.
      widgets: slot(h, 24), queuePanel: slot(h, 12), attachmentBar: null,
      deliveryNotice: null, onHeightChange: (height) => reports.push(height),
    }));
    await h.act(render);
    await h.flushFrames();
    assert.deepEqual(reports, [36]);
    h.reset();
    for (let i = 0; i < 20; i++) await h.act(render);
    assert.equal(h.metrics.heightReads, 0);
    assert.equal(h.metrics.styleReads, 0);
    assert.deepEqual(reports, [36]);
  });
});

test("StrictMode replays keep one observer and cancel pending first-frame work on unmount", async () => {
  await withComposerReact(async (h) => {
    const Extras = loadExtras(h);
    const reports = [];
    await h.act(() => h.root.render(h.React.createElement(h.React.StrictMode, null,
      h.React.createElement(Extras, { widgets: slot(h, 24), deliveryNotice: null, attachmentBar: null,
        onHeightChange: (height) => reports.push(height) }))));
    assert.deepEqual(h.resources(), { frames: 1, observers: 1 });
    await h.act(() => h.root.unmount());
    assert.deepEqual(h.resources(), { frames: 0, observers: 0 });
    await h.flushFrames();
    assert.deepEqual(reports, []);
  });
});

test("existing observer reports to the latest callback after parent rerenders", async () => {
  await withComposerReact(async (h) => {
    const Extras = loadExtras(h);
    const reports = [];
    const render = (height, revision) => h.root.render(h.React.createElement(Extras, {
      widgets: slot(h, height), deliveryNotice: null, attachmentBar: null,
      onHeightChange: (extra) => reports.push([revision, extra]),
    }));
    await h.act(() => render(24, "first"));
    await h.flushFrames();
    await h.act(() => render(48, "latest"));
    await h.resize();
    assert.deepEqual(reports, [["first", 24], ["latest", 48]]);
  });
});

test("widgets, queue and attachment size changes report growth and shrink through ResizeObserver", async () => {
  await withComposerReact(async (h) => {
    const Extras = loadExtras(h);
    const reports = [];
    const render = (widgets, queue, attachment) => h.root.render(h.React.createElement(Extras, {
      widgets: widgets ? slot(h, widgets) : null, queuePanel: queue ? slot(h, queue) : null,
      attachmentBar: attachment ? slot(h, attachment) : null, deliveryNotice: null,
      onHeightChange: (height) => reports.push(height),
    }));
    await h.act(() => render(24, 12, 0));
    assert.deepEqual(reports, []); // Panel registration precedes first-frame reporting.
    await h.flushFrames();
    assert.deepEqual(reports, [36]);
    await h.act(() => render(48, 20, 32));
    await h.resize();
    await h.flushFrames();
    assert.equal(reports.at(-1), 108);
    h.setGap(12);
    await h.resize();
    await h.flushFrames();
    assert.equal(reports.at(-1), 112);
    await h.act(() => render(0, 0, 0));
    await h.resize();
    await h.flushFrames();
    assert.equal(reports.at(-1), 0);
    const count = reports.length;
    await h.resize();
    await h.flushFrames();
    assert.equal(reports.length, count);
    await h.act(() => h.root.unmount());
    assert.deepEqual(h.resources(), { frames: 0, observers: 0 });
  });
});
