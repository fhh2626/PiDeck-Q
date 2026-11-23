import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const streamdownChrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
const stylesEntry = readFileSync("src/renderer/src/styles.css", "utf8");

const brand = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
const sidebar = readFileSync("src/renderer/src/components/sidebar/AppSidebar.tsx", "utf8");
const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");

test("custom titlebar content is flush to window top (no shell padding strip)", () => {
  assert.match(
    foundation,
    /\.wechat-shell\.custom-titlebar-enabled \{[\s\S]*?padding-top:\s*0;/,
  );
  assert.match(
    foundation,
    /\.window-drag-layer \{[\s\S]*?background:\s*transparent;/,
  );
  assert.doesNotMatch(
    foundation,
    /\.custom-titlebar-enabled \.chat-pane[\s\S]{0,80}margin-top:\s*calc\(-1 \* var\(--window-drag-height\)\)/,
  );
  assert.match(
    foundation,
    /\.custom-titlebar-enabled:not\(\.drawer-open\) \.workspace-toolbar \{[\s\S]*?margin-right:\s*var\(--window-controls-width\);/,
  );
});

test("window controls are compact and match drag-layer inset", () => {
  assert.match(foundation, /--window-drag-height:\s*40px/);
  assert.match(foundation, /--window-controls-width:\s*144px/);
  assert.match(foundation, /grid-template-columns:\s*repeat\(4,\s*36px\)/);
  assert.match(
    foundation,
    /\.window-drag-layer \{[\s\S]*?right:\s*var\(--window-controls-width\)/,
  );
  assert.match(
    foundation,
    /\.window-controls \{[\s\S]*?width:\s*var\(--window-controls-width\)/,
  );
});

test("window controls stay above workspace controls so close is never covered", () => {
  assert.match(foundation, /\.window-controls \{[\s\S]*?z-index:\s*940;/);
  assert.match(
    foundation,
    /\.custom-titlebar-enabled \.workspace-toolbar \{[\s\S]*?z-index:\s*930;/,
  );
  // Transparent drag layer must stay below controls/logo (930). Raising it would
  // swallow clicks; Qt drag is forwarded from AppShell capture instead.
  assert.match(foundation, /\.window-drag-layer \{[\s\S]*?z-index:\s*900;/);
  assert.match(shell, /onPointerDownCapture/);
  assert.match(shell, /onDoubleClickCapture/);
  assert.match(shell, /enableNativeResize/);
  assert.match(shell, /shouldBeginWindowDrag\(event\.target\)/);
});

test("workbench content sits below shared workspace chrome (no double drag padding)", () => {
  const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
  // Tab 栏已抬到 WorkbenchStage chrome；内容区再叠 window-drag padding 会空出一条缝
  assert.doesNotMatch(
    surfaces,
    /\.custom-titlebar-enabled \.workbench-content-frame \{[\s\S]*?padding-top:\s*var\(--window-drag-height\);/,
  );
  // 关闭/动作钮仍须 no-drag（header 可能贴近顶栏）
  assert.match(
    foundation,
    /\.custom-titlebar-enabled \.file-diff-header[\s\S]*?-webkit-app-region:\s*no-drag;/,
  );
  assert.match(
    foundation,
    /\.custom-titlebar-enabled \.file-diff-header button[\s\S]*?-webkit-app-region:\s*no-drag;/,
  );
});

test("window control hover uses solid hover surface", () => {
  assert.match(
    foundation,
    /\.window-control:hover \{[\s\S]*?background:\s*var\(--color-bg-hover\);/,
  );
});

test("brand lockup is larger inside the 40px titlebar", () => {
  assert.match(brand, /PiLogoCanvas size=\{28\}/);
  assert.match(sidebar, /list-toolbar flex h-10/);
  assert.doesNotMatch(sidebar, /list-toggle-native floating/);
});

test("mac window chrome keeps one platform-owned traffic-light set", () => {
  const header = readFileSync("src/renderer/src/components/AppHeader.tsx", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  const nativeWindow = readFileSync("native/src/MainWindow.cpp", "utf8");
  const nativePolicy = readFileSync("native/src/NativeWindowPolicy.cpp", "utf8");
  const appearance = readFileSync("src/renderer/src/components/app/settings/AppearanceTab.tsx", "utf8");
  // Electron hiddenInset and native Qt both suppress renderer window buttons;
  // Qt additionally forces system decorations because macOS frameless resize is unsupported.
  assert.match(header, /const showCustomWindowControls = platform !== "darwin"/);
  assert.match(nativePolicy, /#ifdef Q_OS_MACOS[\s\S]*return true/);
  assert.match(appearance, /nativeTitleBarRequired = isNativeRuntime && props\.platform === "darwin"/);
  assert.match(appearance, /disabled=\{nativeTitleBarRequired\}/);
  assert.match(shell, /mac-custom-titlebar/);
  assert.match(app, /platform=\{appInfo\.platform\}/);
  assert.match(app, /detectRendererPlatform\(\)/);
  assert.match(nativeWindow, /Qt::FramelessWindowHint/);
  assert.match(nativeWindow, /useNativeTitleBar/);
  assert.match(
    foundation,
    /\.wechat-shell\.custom-titlebar-enabled\.mac-custom-titlebar \{[\s\S]*--window-controls-width:\s*0px;/,
  );
  assert.match(
    foundation,
    /\.wechat-shell\.custom-titlebar-enabled\.mac-custom-titlebar\.list-collapsed \{[\s\S]*--workspace-toolbar-left-inset:/,
  );
  assert.match(sidebar, /pl-\[max\(0\.625rem,var\(--traffic-lights-width/);
});

test("streamdown code-block and table chrome share utilities-layer card skin", () => {
  assert.match(
    stylesEntry,
    /@import\s+"\.\/styles\/streamdownChrome\.css"\s+layer\(utilities\)\s*;/,
  );
  assert.match(
    streamdownChrome,
    /\[data-streamdown="code-block"\] \{[\s\S]*?gap:\s*0;[\s\S]*?padding:\s*0;/,
  );
  assert.match(
    streamdownChrome,
    /\[data-streamdown="code-block-body"\] \{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;/,
  );
  assert.match(
    streamdownChrome,
    /\[data-streamdown="table-wrapper"\] \{[\s\S]*?border-radius:\s*var\(--density-radius-surface\);/,
  );
  assert.match(
    streamdownChrome,
    /\[data-streamdown="code-block-header"\] \{[\s\S]*?height:\s*var\(--density-code-header-height\);/,
  );
});
