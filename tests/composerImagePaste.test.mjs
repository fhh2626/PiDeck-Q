import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  composerImageBase64Bytes,
  dataUrlToFile,
  exceedsComposerImagePayloadBudget,
  imageMimeTypeFromPath,
  isImageFilePath,
} from "../src/renderer/src/utils/composerImages.ts";

/**
 * 会话附件两条修复的回归测试：
 * 1) 附件选择器默认只选文件（Windows 上 openFile+openDirectory 并存会退化「只选文件夹」）；
 * 2) 复制图片文件粘贴 → 附加图片预览，失败回退 @path 引用。
 */

// ── 纯函数：图片路径判定 / MIME 推导 / dataURL→File ──

test("isImageFilePath 识别受支持图片扩展名（大小写/空格/多段扩展名）", () => {
  assert.equal(isImageFilePath("C:\\Users\\me\\Pictures\\shot.PNG"), true);
  assert.equal(isImageFilePath("/home/me/photo.jpeg"), true);
  assert.equal(isImageFilePath("/home/me/a b.webp"), true);
  assert.equal(isImageFilePath("C:\\Users\\me\\archive.tar.png"), true);
  assert.equal(isImageFilePath("/home/me/doc.txt"), false);
  assert.equal(isImageFilePath("/home/me/photo.bmp"), false);
  assert.equal(isImageFilePath("/home/me/noext"), false);
  assert.equal(isImageFilePath("C:\\Users\\me\\folder"), false);
});

test("imageMimeTypeFromPath 按扩展名推导 MIME", () => {
  assert.equal(imageMimeTypeFromPath("a.png"), "image/png");
  assert.equal(imageMimeTypeFromPath("a.jpg"), "image/jpeg");
  assert.equal(imageMimeTypeFromPath("a.JPEG"), "image/jpeg");
  assert.equal(imageMimeTypeFromPath("a.gif"), "image/gif");
  assert.equal(imageMimeTypeFromPath("a.webp"), "image/webp");
  assert.equal(imageMimeTypeFromPath("a.unknown"), "image/png");
});

test("图片总 base64 payload 遵守 Native RPC 预算", () => {
  const under = [{ type: "image", data: "x".repeat(1024), mimeType: "image/png" }];
  const over = [{ type: "image", data: "x".repeat(25 * 1024 * 1024), mimeType: "image/png" }];
  assert.equal(composerImageBase64Bytes(under), 1024);
  assert.equal(exceedsComposerImagePayloadBudget(under), false);
  assert.equal(exceedsComposerImagePayloadBudget(over), true);
});

test("dataUrlToFile 解码 base64 字节、MIME 与文件名正确", async () => {
  // base64("ABC") = QUJD
  const file = dataUrlToFile("data:image/png;base64,QUJD", "image/png", "shot.png");
  assert.equal(file.name, "shot.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 3);
  assert.deepEqual(Array.from(new Uint8Array(await file.arrayBuffer())), [65, 66, 67]);
});

// ── 源码级接线断言：对话框 properties 与粘贴分支 ──

const filesIpc = readFileSync("src/main/ipc/filesIpc.ts", "utf8");
const preload = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
const controller = readFileSync(
  "src/renderer/src/hooks/useSessionComposerController.ts",
  "utf8",
);

test("附件选择器默认仅选文件，includeDirectories 才同时选目录", () => {
  // 默认 properties 不含 openDirectory（Windows 上并存会退化为「只选文件夹」）
  assert.match(
    filesIpc,
    /properties: options\?\.includeDirectories\s*\?\s*\["openFile", "openDirectory", "multiSelections"\]\s*:\s*\["openFile", "multiSelections"\]/,
  );
  assert.match(
    preload,
    /pickFiles: \(options\?:\s*\{ title\?: string; includeDirectories\?: boolean \}\)/,
  );
});

test("readBase64 支持 maxBytes 预检，粘贴图片超大时主进程拦截", () => {
  assert.match(filesIpc, /filesReadBase64, async \(path: string, maxBytes\?: number\)/);
  assert.match(filesIpc, /FILE_TOO_LARGE/);
  assert.match(preload, /readBase64: \(path: string, maxBytes\?: number\)/);
});

test("onPaste 图片文件走预览分支，失败回退 @path 引用", () => {
  assert.match(controller, /clipboardPaths\.every\(isImageFilePath\)/);
  assert.match(controller, /pasteClipboardImages\(clipboardPaths, event\.clipboardData\)/);
  assert.match(controller, /readBase64\(path, COMPOSER_IMAGE_MAX_BYTES\)/);
  assert.match(controller, /insertFilePathRefs\(paths\)/);
});

test("粘贴图片读取失败时兜底剪贴板位图，不直接退化成 @path 引用", () => {
  // 路径文件被删/超大时：事件粘贴取 clipboardData 位图，右键粘贴取 Electron 剪贴板位图
  assert.match(controller, /getClipboardImageFiles\(dataTransfer\)/);
  assert.match(controller, /desktopApi\.clipboard\.readImage\(\)/);
  assert.match(controller, /clipboard-image\.png/);
});

test("位图分支优先于纯文本路径提取（微信/QQ 复制图片 text 槽是缓存路径）", () => {
  // 微信等复制图片：剪贴板=位图+text 槽缓存路径（无 CF_HDROP）。若路径提取在前，
  // Ctrl+V 会把附带路径粘成 @C:\... 引用、位图分支永远轮不到（右键粘贴却正常）。
  const imageBranch = controller.indexOf("getClipboardImageFiles(event.clipboardData)");
  const pathExtract = controller.indexOf("extractPastedPath(");
  assert.ok(imageBranch >= 0 && pathExtract >= 0, "两个分支都应存在");
  assert.ok(
    imageBranch < pathExtract,
    `位图检查应在路径提取之前（实际 image=${imageBranch} path=${pathExtract}）`,
  );
  assert.match(controller, /paths\.every\(isImageFilePath\)/);
  assert.match(controller, /位图才是用户要的内容/);
});

test("右键粘贴：图片/文件路径走 controller，纯文本返回 false 交给编辑器", () => {
  assert.match(controller, /pasteFromClipboard/);
  assert.match(controller, /onPasteClipboard: pasteFromClipboard/);
  assert.match(controller, /Promise<boolean>/);
  const tipTap = readFileSync("src/renderer/src/components/session/composer/TipTapComposer.tsx", "utf8");
  assert.match(tipTap, /const handled = await props\.onPasteClipboard\?\.\(\);/);
  assert.match(tipTap, /if \(!handled\) insertClipboard\(editor\);/);
});

test("preload 暴露剪贴板位图读取（readImage，空图返回空串）", () => {
  assert.match(preload, /readImage: \(\) => \{/);
  assert.match(preload, /syncHost\.readClipboardImage\(\)/);
  assert.match(preload, /return image;/);
});
