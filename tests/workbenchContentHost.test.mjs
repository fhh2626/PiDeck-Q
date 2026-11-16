import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const stage = readFileSync("src/renderer/src/components/workspace/WorkbenchStage.tsx", "utf8");
const content = readFileSync("src/renderer/src/components/workspace/WorkbenchContent.tsx", "utf8");
const fileEditor = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");

test("WorkbenchStage hosts session + content with collapse-safe maximize", () => {
  assert.match(stage, /export function WorkbenchStage/);
  assert.match(stage, /layout === "maximize"/);
  assert.match(stage, /panel\.collapse\(\)/);
  assert.match(stage, /panel\.expand\(\)/);
  assert.match(stage, /chrome\?:/);
  assert.match(stage, /from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/types"/);
  // 分屏固定左右：不接受 props.orientation，面板组硬编码 horizontal，无 vertical 分支
  assert.doesNotMatch(stage, /props\.orientation/);
  assert.match(stage, /orientation="horizontal"/);
  assert.match(app, /<WorkbenchStage/);
  assert.match(app, /workbenchHasContent/);
  assert.match(app, /WorkbenchContent/);
  assert.match(app, /chrome=\{workspaceToolbarNode\}/);
  // 尺寸必须字符串百分比 + defaultSize 恒定：react-resizable-panels v4 约束派生把
  // 数字按 px 解析（minSize={20} → 2%），且 defaultSize 随 layout 切换会触发 Panel
  // 重注册、丢失 expandToSize，导致 maximize→split 恢复成窄缝（回归点）。
  assert.match(stage, /collapsedSize="0%"/);
  assert.match(stage, /minSize="20%"/);
  assert.match(stage, /defaultSize="48%"/);
  assert.doesNotMatch(stage, /defaultSize=\{props\.layout === "maximize" \? 0 : 48\}/);
  // 阅读面静态引入 FileDiffViewer：避免 lazy 动态 import 在 Electron/Vite 下偶发失败且无法重试恢复
  assert.doesNotMatch(app, /lazy\(\(\) => import\("\.\/components\/app\/FileDiffViewer"/);
  assert.doesNotMatch(content, /lazy\(\(\) =>/);
  assert.match(content, /import \{ FileDiffViewer \} from "\.\.\/app\/FileDiffViewer"/);
});

test("file view and git diff open into workbench modes, not drawer overlays", () => {
  assert.match(fileEditor, /editorMode: WorkspaceContentOpenMode/);
  assert.match(fileEditor, /gitDiffDisplayMode: WorkspaceContentOpenMode/);
  assert.match(fileEditor, /contentOpenMode: WorkspaceContentOpenMode/);
  // 打开文件不再切抽屉到 editor
  const viewBlock = fileEditor.slice(
    fileEditor.indexOf("const viewFilePath = useCallback"),
    fileEditor.indexOf("const diffFilePath = useCallback"),
  );
  assert.doesNotMatch(viewBlock, /setDrawer\("editor"\)/);
  assert.match(viewBlock, /contentOpenModeRef\.current/);
  // Git Diff 不再要求 drawer 叠层
  assert.doesNotMatch(drawer, /git-drawer-detail/);
  assert.doesNotMatch(drawer, /displayMode="drawer"/);
  // App 不再挂 body modal 阅读面
  assert.doesNotMatch(app, /editorMode === "modal"/);
  assert.doesNotMatch(app, /gitDiffDisplayMode === "modal"/);
  assert.match(content, /displayMode=\{props\.gitDiffDisplayMode\}/);
  assert.match(content, /displayMode=\{props\.editorMode\}/);
});

test("closing git diff dismisses the whole workbench reading surface", () => {
  // 关 Diff 时一并清文件 tab，避免优先渲染切回 editor 像「关不掉」
  assert.match(fileEditor, /dismissWorkbenchContent/);
  assert.match(fileEditor, /closeGitDiff:\s*dismissWorkbenchContent/);
  const openWorkspace = fileEditor.slice(
    fileEditor.indexOf("const openWorkspaceFileDiffFn"),
    fileEditor.indexOf("const openCommitFileDiffFn"),
  );
  assert.match(openWorkspace, /setActiveTabId\(null\)/);
  assert.match(openWorkspace, /setEditorTabs\(\[\]\)/);
});
