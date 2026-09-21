import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 预览弹层重构契约（Review P2）：
// 1. ImagePreviewModal 只保留一层 overlay（共享 DialogContent 内部自带的），不再手写 DialogOverlay；
// 2. 关闭按钮只有一颗（showCloseButton=false），全屏布局覆盖基类 translate-50% / sm:max-w-lg；
// 3. 主路径（时间线 Gallery / 用户气泡 / Composer 附件栏）点开预览必须携带同组图片数组，
//    使 ArrowLeft/ArrowRight 组内导航真正可用；磁盘单文件预览保持单张。

const messageImage = readFileSync(
  "src/renderer/src/components/session/MessageImage.tsx",
  "utf8",
);
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const gallery = readFileSync(
  "src/renderer/src/components/session/MessageImageGallery.tsx",
  "utf8",
);
const composerPanels = readFileSync(
  "src/renderer/src/components/session/ComposerPanels.tsx",
  "utf8",
);
const zhCn = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUs = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("ImagePreviewModal: no manual overlay, single close button, fullscreen overrides, explicit focus & dismissal", () => {
  // 不再自绘第二层 overlay（共享 DialogContent 内部已渲染 DialogOverlay）
  assert.doesNotMatch(messageImage, /<DialogOverlay/, "MessageImage.tsx 不得再手写 DialogOverlay");
  // 关闭按钮唯一：禁用共享 content 的默认关闭钮
  assert.match(messageImage, /showCloseButton=\{false\}/);
  // 覆盖基类定位：translate 必须归零、max-width 必须放开
  assert.match(messageImage, /translate-x-0/);
  assert.match(messageImage, /translate-y-0/);
  assert.match(messageImage, /sm:max-w-none/);
  // DialogContent 不得覆盖 z-50，应继承共享 Dialog 的 z-(--z-dialog) 确保在 overlay 上方
  assert.doesNotMatch(
    messageImage,
    /<DialogContent[^>]*className="[^"]*\bz-50\b/,
    "DialogContent 自身不得设置 z-50",
  );
  // 左右导航按钮文案必须走 i18n，不允许硬编码英文
  assert.doesNotMatch(messageImage, /aria-label="Previous image"/);
  assert.doesNotMatch(messageImage, /aria-label="Next image"/);
  assert.match(messageImage, /t\("app\.imagePreviewPrevious"\)/);
  assert.match(messageImage, /t\("app\.imagePreviewNext"\)/);
  // 结构保护：必须显式注册 onCloseAutoFocus 与 returnFocusRef 恢复打开前焦点
  assert.match(messageImage, /onCloseAutoFocus=/);
  assert.match(messageImage, /returnFocusRef/);
  // Esc/overlay 关闭必须经 Dialog onOpenChange 回到 onClose
  assert.match(messageImage, /onOpenChange=/);
});

test("main-path preview carries sibling gallery for arrow navigation", () => {
  // 时间线链路：回调签名带第二参 images
  assert.match(gallery, /onPreviewImage\(image, props\.images\)/);
  // Composer 附件栏：预览携带全部附件
  assert.match(composerPanels, /onPreview\(image, props\.images\)/);
  // App 顶层挂载：ImagePreviewModal 同时接收 image 与 images
  const modalStart = app.indexOf("<ImagePreviewModal\n");
  assert.ok(modalStart >= 0, "App.tsx 必须挂载 ImagePreviewModal");
  const modalBlock = app.slice(modalStart, app.indexOf("/>", modalStart) + 2);
  assert.match(modalBlock, /image=\{previewImage\.image\}/);
  assert.match(modalBlock, /images=\{previewImage\.images\}/);
  // 磁盘文件预览：只包单张 image，不伪造 gallery（不携带 images 字段）
  const fileOpen = app.match(/setPreviewImage\(\{ image: \{ type: "image"/);
  assert.ok(fileOpen, "文件链接打开图片仍走单张预览");
});

test("i18n: previous/next labels exist in zh-CN and en-US", () => {
  for (const [name, source] of [["zh-CN", zhCn], ["en-US", enUs]]) {
    assert.match(source, /"app\.imagePreviewPrevious"/, `${name} 缺少 app.imagePreviewPrevious`);
    assert.match(source, /"app\.imagePreviewNext"/, `${name} 缺少 app.imagePreviewNext`);
  }
});
