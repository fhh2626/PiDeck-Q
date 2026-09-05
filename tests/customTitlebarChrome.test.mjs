import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const streamdownChrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
const stylesEntry = readFileSync("src/renderer/src/styles.css", "utf8");
const header = readFileSync("src/renderer/src/components/AppHeader.tsx", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const preload = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
const brand = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
const sidebar = readFileSync("src/renderer/src/components/sidebar/AppSidebar.tsx", "utf8");
const tabs = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
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
    /\.custom-titlebar-enabled:not\(\.drawer-open\) \.session-tabs-bar \{[\s\S]*?margin-right:\s*var\(--window-controls-width\);/,
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

const mainWindowControls = readFileSync("src/native-node/host/NativeMainWindowControls.ts", "utf8");

test("maximize button tracks window state with restore icon", () => {
  assert.match(header, /function RestoreIcon/);
  assert.match(header, /maximized \? <RestoreIcon/);
  assert.match(header, /app\.windowRestore/);
  assert.match(header, /app\.windowMaximize/);
  assert.match(ipc, /appWindowIsMaximized/);
  assert.match(ipc, /appWindowMaximizedChanged/);
  assert.match(systemIpc, /appWindowIsMaximized/);
  assert.match(mainWindowControls, /window\.maximizedChanged/);
  assert.match(mainWindowControls, /toggleAlwaysOnTop/);
  assert.match(readFileSync("src/renderer/src/native/rendererZoom.ts", "utf8"), /document\.documentElement\.style\.zoom/);
  assert.match(mainWindowControls, /notifyTitleBarChange/);
  assert.match(preload, /isWindowMaximized:/);
  assert.match(preload, /onWindowMaximizedChange:/);
  assert.match(preload, /toggleMaximizeWindow:[\s\S]*Promise<boolean>/);
});

test("window controls stay above session tabs so close is never covered", () => {
  assert.match(foundation, /\.window-controls \{[\s\S]*?z-index:\s*940;/);
  assert.match(
    foundation,
    /\.custom-titlebar-enabled \.session-tabs-bar \{[\s\S]*?z-index:\s*930;/,
  );
  // Transparent drag layer must stay below tabs/logo (930). Raising it would
  // swallow clicks; Qt drag is forwarded from AppShell capture instead.
  assert.match(foundation, /\.window-drag-layer \{[\s\S]*?z-index:\s*900;/);
  assert.match(shell, /onPointerDownCapture/);
  assert.match(shell, /onDoubleClickCapture/);
  assert.match(shell, /enableNativeResize/);
  assert.match(shell, /shouldBeginWindowDrag\(event\.target\)/);
});

test("workbench content sits below shared tabs chrome (no double drag padding)", () => {
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

test("session tabs bar keeps trailing inset for drawer toggle (no px-* override)", () => {
  const tabs = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
  // utility px-* 会冲掉 foundation 的右边距，导致开关钻进窗口控件下
  assert.doesNotMatch(tabs, /session-tabs-bar[^"]*px-\d/);
  assert.match(tabs, /session-tabs-bar[^\"]*pl-\[max\(0\.5rem,var\(--session-tabs-left-inset/);
  assert.doesNotMatch(tabs, /session-tabs-bar[^\"]*\bpl-2\b/);
  assert.match(tabs, /header-drawer-toggle/);
  assert.match(tabs, /PanelRight/);
  // margin 让位 + min-width:0：避免 flex 内容把 drag 区撑进窗口控件
  assert.match(
    foundation,
    /\.custom-titlebar-enabled:not\(\.drawer-open\) \.session-tabs-bar \{[\s\S]*?margin-right:\s*var\(--window-controls-width\);/,
  );
  assert.match(
    foundation,
    /\.custom-titlebar-enabled \.session-tabs-bar \{[\s\S]*?min-width:\s*0;/,
  );
  assert.match(
    foundation,
    /\.window-controls,\s*\n\.window-controls \* \{[\s\S]*?-webkit-app-region:\s*no-drag;/,
  );
});

test("toggle maximize tracks intent without stale isMaximized reads", () => {
  assert.match(mainWindowControls, /toggleMaximize\(\): Promise<boolean>/);
  assert.match(mainWindowControls, /window\.maximizedChanged/);
  assert.match(mainWindowControls, /appWindowMaximizedChanged/);
  assert.doesNotMatch(
    systemIpc,
    /win\.webContents\.send\(ipcChannels\.appWindowMaximizedChanged,\s*win\.isMaximized\(\)\)/,
  );
  assert.doesNotMatch(
    systemIpc,
    /win\.maximize\(\);\s*\n\s*return win\.isMaximized\(\)/,
  );
  // 渲染层禁止乐观翻转：否则会与主进程推送互踩
  assert.doesNotMatch(header, /setMaximized\(\(current\)\s*=>\s*!current\)/);
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
    /\.wechat-shell\.custom-titlebar-enabled\.mac-custom-titlebar\.list-collapsed \{[\s\S]*--session-tabs-left-inset:/,
  );
  assert.match(sidebar, /pl-\[max\(0\.625rem,var\(--traffic-lights-width/);
});

test("collapsed sidebar keeps 14px gutter; restore lives in tab bar", () => {
  assert.match(shell, /LIST_COLLAPSED_SIZE = 0/);
  assert.match(foundation, /\.list-collapsed \.shell-panel-list/);
  assert.match(foundation, /\.list-collapsed \.chat-list-pane \{\s*display:\s*none;/);
  assert.doesNotMatch(foundation, /list-toggle-native\.floating/);
  assert.match(tabs, /listCollapsed && props\.onToggleListCollapsed/);
  assert.match(tabs, /PanelLeft/);
  // Tab 栏必须压过透明拖拽层，否则展开按钮点不到。拖动改由外壳捕获阶段转发，
  // 不能把透明层抬到 930 以上，否则会挡住 Tab 和按钮。
  assert.match(
    foundation,
    /\.custom-titlebar-enabled \.session-tabs-bar \{[\s\S]*?z-index:\s*930;/,
  );
});

test("drawer toggle stays on session tab bar right; no gap when drawer open", () => {
  assert.match(tabs, /header-drawer-toggle/);
  assert.match(tabs, /PanelRight/);
  assert.doesNotMatch(tabs, /onToggleDrawer && !props\.drawerOpen/);
  const rail = readFileSync("src/renderer/src/components/workspace/WorkspaceDrawerRail.tsx", "utf8");
  assert.doesNotMatch(rail, /onClose/);
  assert.doesNotMatch(rail, /drawer-rail-close/);
  // 抽屉打开后窗口控件叠在抽屉顶上，会话 Tab 不再预留 144px，开关贴在 Tab 栏右缘。
  // drawer-open 必须同时要求未折叠：折叠后聊天区顶到窗口右缘，Tab 栏仍须让位，
  // 否则抽屉开关会与关闭按钮重叠。
  assert.match(
    shell,
    /drawer && !drawerCollapsed \? "drawer-open" : ""/,
  );
  assert.match(
    foundation,
    /\.custom-titlebar-enabled:not\(\.drawer-open\) \.session-tabs-bar \{[\s\S]*?margin-right:\s*var\(--window-controls-width\);/,
  );
  assert.match(
    foundation,
    /\.custom-titlebar-enabled \.shell-panel-drawer \.detail-drawer \{[\s\S]*?padding-top:\s*var\(--window-drag-height\);/,
  );
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
    /\[data-streamdown="table-wrapper"\] \{[\s\S]*?border-radius:\s*12px;/,
  );
  assert.match(
    streamdownChrome,
    /\[data-streamdown="code-block-header"\] \{[\s\S]*?height:\s*34px;/,
  );
});
