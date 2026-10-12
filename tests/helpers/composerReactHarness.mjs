import React, { act } from "react";
import { parseHTML } from "linkedom";

/** Real React lifecycle with deterministic browser measurements and owned frame/observer cleanup. */
export async function withComposerReact(run) {
  const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
  window.location = { protocol: "http:", href: "http://localhost/" };
  const frames = new Map();
  const observers = new Set();
  const metrics = { heightReads: 0, styleReads: 0 };
  let nextFrame = 0;
  let gap = 8;
  const offsetDescriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      metrics.heightReads++;
      return Array.from(this.querySelectorAll("[data-fixture-height]"))
        .reduce((sum, el) => sum + Number(el.getAttribute("data-fixture-height")), 0);
    },
  });
  window.getComputedStyle = () => { metrics.styleReads++; return { rowGap: String(gap) }; };
  class ResizeObserverDouble {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.add(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); observers.delete(this); }
  }
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: ResizeObserverDouble,
    requestAnimationFrame: (fn) => { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let root;
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const { createRoot } = await import("react-dom/client");
    root = createRoot(window.document.getElementById("root"));
    await run({
      React, act, root, window, globals, metrics,
      async flushFrames() { await act(() => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(0); }); },
      async resize() { await act(() => { for (const observer of observers) observer.callback([]); }); },
      setGap: (value) => { gap = value; },
      reset: () => { metrics.heightReads = metrics.styleReads = 0; },
      resources: () => ({ frames: frames.size, observers: observers.size }),
    });
  } finally {
    if (root) await act(() => root.unmount());
    if (offsetDescriptor) Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", offsetDescriptor);
    else delete window.HTMLElement.prototype.offsetHeight;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
