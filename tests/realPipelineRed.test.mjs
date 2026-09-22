import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createHookHarness, nodes, deferred, flush } from "./helpers/imagePreviewHarness.mjs";
const image = (data) => ({ type: "image", mimeType: "image/png", data });
function controller(extra = {}) {
  const harness = createHookHarness(), requests = [], toasts = [];
  const options = { readBase64: (path, maxBytes) => { const d = deferred(); requests.push({ ...d, path, maxBytes }); return d.promise; }, openFile: async () => {}, showToast: (key) => toasts.push(key), ...extra };
  const { useImagePreviewController } = loadTsCommonJs("src/renderer/src/hooks/useImagePreviewController.ts", { stubs: { react: harness.react, "../i18n": { t: (key) => key } } });
  const render = () => harness.render(() => useImagePreviewController({ ...options }));
  return { ...harness, requests, toasts, render };
}
test("production controller latest read wins, callbacks stay stable, message preview clears local path", async () => {
  const h = controller(), first = h.render();
  first.openLocalImage("a.png"); first.openLocalImage("b.png"); await flush();
  assert.equal(h.requests[1].path, "b.png");
  assert.equal(h.requests[1].maxBytes, 10 * 1024 * 1024);
  h.requests[1].resolve("B"); await flush();
  assert.equal(h.render().previewImage.localSourcePath, "b.png");
  h.requests[0].resolve("A"); await flush();
  assert.equal(h.render().previewImage.image.data, "B");
  assert.equal(h.render().openLocalImage, first.openLocalImage);
  first.openMessageImage(image("message"));
  assert.equal(h.render().previewImage.localSourcePath, undefined);
});
for (const action of ["close", "unmount", "message"]) for (const failure of [false, true]) {
  test(`production controller ignores late ${failure ? "failure" : "success"} after ${action}`, async () => {
    const h = controller(), c = h.render(); c.openLocalImage("a.png"); await flush();
    if (action === "close") c.closePreview();
    if (action === "unmount") h.unmount();
    if (action === "message") c.openMessageImage(image("message"));
    failure ? h.requests[0].reject(new Error("ENOENT")) : h.requests[0].resolve("late"); await flush();
    assert.equal(h.render().previewImage?.image.data ?? null, action === "message" ? "message" : null);
    assert.deepEqual(h.toasts, []);
  });
}
for (const kind of ["sync", "async"]) test(`production logging ${kind} failure cannot suppress feedback`, async () => {
  const h = controller({ log: () => { if (kind === "sync") throw new Error("logger"); return Promise.reject(new Error("logger")); } });
  h.render().openLocalImage("a.png"); await flush(); h.requests[0].reject(new Error("ENOENT")); await flush();
  assert.deepEqual(h.toasts, ["app.imageNotFoundOrEmpty"]);
});

function modal() {
  const h = createHookHarness(), listeners = new Map(), notices = [];
  const { ImagePreviewModal } = loadTsCommonJs("src/renderer/src/components/session/MessageImage.tsx", {
    globals: { window: { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: (key) => listeners.delete(key) } },
    stubs: { react: h.react, "../../i18n": { t: (key) => key }, "../../utils/notice": { showNotice: (key) => notices.push(key) }, "../ui-shadcn/dialog": { Dialog: "Dialog", DialogContent: "DialogContent" }, "../ui-shadcn/button": { Button: "Button" } },
  });
  return { ...h, notices, listeners, render: (props) => h.render(() => ImagePreviewModal(props)) };
}
test("production modal keyboard navigation does not confuse equal-length equal-prefix images", () => {
  const bad = image("x".repeat(64) + "bad"), good = image("x".repeat(64) + "yes");
  const h = modal(), props = { image: bad, images: [bad, good], onClose() {} };
  nodes(h.render(props), (n) => n.type === "img")[0].props.onError();
  assert.equal(nodes(h.render(props), (n) => n.type === "img").length, 0);
  h.listeners.get("keydown")({ key: "ArrowRight", preventDefault() {} });
  assert.equal(nodes(h.render(props), (n) => n.type === "img")[0]?.props.src, `data:image/png;base64,${good.data}`);
  h.listeners.get("keydown")({ key: "ArrowLeft", preventDefault() {} });
  assert.equal(nodes(h.render(props), (n) => n.type === "img").length, 0);
  assert.equal(nodes(h.render({ image: good, onClose() {} }), (n) => n.type === "img").length, 1);
  h.unmount(); assert.equal(h.listeners.size, 0);
});
test("production modal system open forwards exact path, reports failure, then hides action for message image", async () => {
  const h = modal(), paths = [];
  const props = { image: image("local"), localSourcePath: "C:/项目/a.png", onOpenInSystem: async (path) => { paths.push(path); throw new Error("open failed"); }, onClose() {} };
  await nodes(h.render(props), (n) => n.type === "Button")[0].props.onClick({ stopPropagation() {} });
  assert.deepEqual(paths, [props.localSourcePath]); assert.deepEqual(h.notices, ["app.imagePreviewOpenInSystemFailed"]);
  assert.equal(nodes(h.render(props), (n) => n.type === "Button")[0].props.disabled, false);
  assert.equal(nodes(h.render({ image: image("message"), onClose() {} }), (n) => n.type === "Button").length, 0);
});

for (const failure of [false, true]) test(`production composer delegation supersedes a pending local read (late failure=${failure})`, async () => {
  const owner = controller(), c = owner.render(); c.openLocalImage("slow.png"); await flush();
  const h = createHookHarness();
  const { useComposerImagePreview } = loadTsCommonJs("src/renderer/src/hooks/useComposerImagePreview.ts", { stubs: { react: h.react } });
  const render = () => h.render(() => useComposerImagePreview(c.openMessageImage));
  render().preview(image("attachment"), [image("attachment")]);
  assert.equal(render().previewImage, null, "desktop composer never mounts a second modal");
  failure ? owner.requests[0].reject(new Error("ENOENT")) : owner.requests[0].resolve("late"); await flush();
  assert.equal(owner.render().previewImage.image.data, "attachment");
  assert.equal(owner.render().previewImage.localSourcePath, undefined);
  assert.deepEqual(owner.toasts, []);
  render().closePreview(); assert.equal(owner.render().previewImage, null);
});
test("standalone composer retains local gallery preview and close", () => {
  const h = createHookHarness();
  const { useComposerImagePreview } = loadTsCommonJs("src/renderer/src/hooks/useComposerImagePreview.ts", { stubs: { react: h.react } });
  const render = () => h.render(() => useComposerImagePreview());
  const img = image("attachment"), gallery = [img];
  render().preview(img, gallery); assert.equal(render().previewImage.images, gallery);
  render().closePreview(); assert.equal(render().previewImage, null);
});
test("system open retains original failure even when log adapter throws", async () => {
  const error = new Error("system open failed"), h = controller({ openFile: async () => { throw error; }, log: () => { throw new Error("logger"); } });
  await assert.rejects(h.render().openInSystem("C:/a.png"), (err) => err === error);
});

// Assembly seam test: execute ComposerArea up to controller injection. The controller
// is intercepted deliberately; its preview behaviour is exercised above, not copied here.
test("ComposerArea injects the desktop session preview action into the composer controller", () => {
  const file = "src/renderer/src/components/session/ComposerArea.tsx";
  const parsed = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const stubs = Object.fromEntries(parsed.statements.filter(ts.isImportDeclaration).map((entry) => [entry.moduleSpecifier.text, {}]));
  const h = createHookHarness(), action = () => {}, stop = new Error("controller boundary");
  let options;
  stubs.react = h.react;
  stubs["./SessionPaneServices"] = { useSessionPaneActions: () => ({ onPreviewImage: action, promoteSessionToPermanent() {} }) };
  stubs["../../hooks/useSessionComposerController"] = { useSessionComposerController: (input) => { options = input; throw stop; } };
  const { ComposerArea } = loadTsCommonJs(file, { stubs });
  assert.throws(() => ComposerArea.render({ sessionId: "s1" }, null), (error) => error === stop);
  assert.equal(options.sessionId, "s1");
  assert.equal(options.onPreviewImage, action);
});

test("production modal system open awaits success and disables repeat clicks", async () => {
  const h = modal(), request = deferred(), paths = [];
  const props = { image: image("local"), localSourcePath: "C:/a.png", onOpenInSystem: (path) => { paths.push(path); return request.promise; }, onClose() {} };
  const pending = nodes(h.render(props), (n) => n.type === "Button")[0].props.onClick({ stopPropagation() {} });
  const busy = nodes(h.render(props), (n) => n.type === "Button")[0];
  assert.equal(busy.props.disabled, true);
  await busy.props.onClick({ stopPropagation() {} });
  assert.deepEqual(paths, ["C:/a.png"]);
  request.resolve(); await pending;
  assert.equal(nodes(h.render(props), (n) => n.type === "Button")[0].props.disabled, false);
  assert.deepEqual(h.notices, []);
});
for (const [result, error, key] of [
  ["", null, "app.imageNotFoundOrEmpty"],
  [123, null, "app.imageReadFormatError"],
  [null, "FILE_TOO_LARGE", "app.imageTooLarge"],
  [null, "FILE_PATH_NOT_AUTHORIZED", "app.imagePermissionDenied"],
  [null, "EIO", "app.imageReadFailed"],
]) test(`production read error feedback: ${key}`, async () => {
  const h = controller(); h.render().openLocalImage("a.png"); await flush();
  error ? h.requests[0].reject(new Error(error)) : h.requests[0].resolve(result); await flush();
  assert.deepEqual(h.toasts, [key]); assert.equal(h.render().previewImage, null);
});
