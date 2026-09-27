import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 与 sessionComposer.test.mjs 相同的 TSX 编译替身模式：只测公开 helper 与源码结构，
// 不挂载真实 React / jotai。
function compile(filePath, stubs = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => stubs[specifier] ?? {};
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
  }, { filename: filePath });
  return module.exports;
}

const chipsPath = "src/renderer/src/components/session/SessionWidgetChips.tsx";
const chipsSource = () => readFileSync(chipsPath, "utf8");
const parserSource = () => readFileSync("src/renderer/src/components/session/agentTodoParser.ts", "utf8");

function loadChipsHelpers() {
  return compile(chipsPath, {
    react: {},
    jotai: {},
    "./ComposerRuntimeIntegrations": {},
    "./ComposerComponents": {},
  });
}

test("widgetProgress counts checkmarks and ignores section headers", () => {
  const { widgetProgress } = loadChipsHelpers();
  // vm 跨 realm 对象的 Object.prototype 不同，不能用 deepEqual，按字段断言
  const progressOf = (lines) => {
    const result = widgetProgress(lines);
    return `${result.done}/${result.total}`;
  };
  assert.equal(progressOf([
    "── 待办 ──",
    "☐ #1 修复登录页样式",
    "☑ #2 更新依赖文档",
    "── 已完成 ──",
    "☑ #3 审查 PR",
  ]), "2/3");
  // 新契约（2027-01）：无分组标题，按插入顺序带标记，完成项原位——计数逻辑不变
  assert.equal(progressOf([
    "☐ #1 修复登录页样式",
    "☑ #2 更新依赖文档",
    "☐ #3 审查 PR",
  ]), "1/3");
  // plan 扩展行格式（步骤号 + 文本）同样按 ☑/☐ 计数
  assert.equal(progressOf([
    "计划进度 1/3",
    "☑ 1. 设计 schema",
    "☐ 2. 实现迁移",
    "☐ 3. 补测试",
  ]), "1/3");
  // 无勾选标记（如 todo 折叠态只回 "2/4" 一行）时 total 为 0，由 UI 退化为首行摘要
  assert.equal(progressOf(["2/4"]), "0/0");
  assert.equal(progressOf([]), "0/0");
});

test("widget dismissal is permanent across restarts and revives only on new content", () => {
  const { isWidgetDismissed, widgetDismissalId, widgetLinesSignature } = loadChipsHelpers();
  const lines = ["── 待办 ──", "☐ #1 修复登录页样式"];
  // 用户在 generation 1 时手动关闭 → 记录当时的内容指纹
  const dismissed = {
    [widgetDismissalId("session-a", "pi-deck-todo")]: widgetLinesSignature(lines),
  };
  // 重启后扩展重建同一列表（可能是 generation 2/3/…）：指纹相同 → 永久保持隐藏
  assert.equal(isWidgetDismissed(dismissed, "session-a", "pi-deck-todo", [...lines]), true);
  // 工具再次调用追加新待办：内容变化 → 自动复活
  assert.equal(
    isWidgetDismissed(dismissed, "session-a", "pi-deck-todo", [...lines, "☐ #2 补测试"]),
    false,
  );
  // 工具 toggle 完成态同样算内容变化 → 复活
  assert.equal(
    isWidgetDismissed(dismissed, "session-a", "pi-deck-todo", ["── 待办 ──", "☑ #1 修复登录页样式"]),
    false,
  );
  // dismiss 按 session 隔离：其他会话不受影响
  assert.equal(isWidgetDismissed(dismissed, "session-b", "pi-deck-todo", [...lines]), false);
  // 按 widgetKey 隔离：todo 的关闭不影响 plan
  assert.equal(isWidgetDismissed(dismissed, "session-a", "pi-deck-plan-todos", [...lines]), false);
});

test("widgetLinesSignature is stable and order/content sensitive", () => {
  const { widgetLinesSignature } = loadChipsHelpers();
  const a = ["☐ #1 任务一", "☐ #2 任务二"];
  assert.equal(widgetLinesSignature(a), widgetLinesSignature([...a]));
  assert.notEqual(widgetLinesSignature(a), widgetLinesSignature([...a].reverse()));
  assert.notEqual(widgetLinesSignature(a), widgetLinesSignature([...a, "☐ #3 任务三"]));
  assert.notEqual(widgetLinesSignature(a), widgetLinesSignature(["☐ #1 任务一改"]));
});

test("widget chips render in the chat header left slot, not the composer", () => {
  // chips 容器带 mr-auto：在 justify-end 的 chat-header-actions 里钉在左端
  assert.match(chipsSource(), /mr-auto flex min-w-0 items-center/);
  // 详情用 shadcn Popover 承载，常驻只显示摘要 chip
  assert.match(chipsSource(), /PopoverTrigger/);
  assert.match(chipsSource(), /PopoverContent/);
  // 只接受当前 runtime 代数一致的 widget，重启后旧快照不复活
  assert.match(chipsSource(), /isCoherentComposerRuntimeUi/);

  const header = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");
  // 头部提供左侧槽位，且渲染在状态/操作按钮之前（视觉最左）
  assert.match(header, /widgetChips\?: ReactNode/);
  assert.ok(header.indexOf("{props.widgetChips}") < header.indexOf("<SessionStatus"));

  const view = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
  // 目录设置属于侧栏 Chat 父项目，不应混入会话徽章；会话槽位只保留运行状态 chips。
  assert.doesNotMatch(view, /ChatDirectoryButton/);
  assert.match(view, /widgetChips=\{<SessionWidgetChips sessionId=\{sessionId\} \/>\}/);

	// composer 不再渲染 widget：槽位类型与渲染点都已移除
	const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	assert.doesNotMatch(area, /ExtensionWidgetCard/);
	assert.doesNotMatch(area, /\{widgets\}/);
	assert.match(area, /widgets=\{props\.widgets \?\? null\}/);
});

test("chip popover uses the official BeUI TodoList with mapping, not a local imitation", () => {
  // 官方组件从 agents/todo-list 引入，widget 行→TodoItem 映射走独立 parser 模块
  assert.match(chipsSource(), /import \{ TodoList \} from "\.\.\/agents\/todo-list";/);
  assert.match(chipsSource(), /import \{ parseAgentTodoItems \} from "\.\/agentTodoParser";/);
  assert.match(parserSource(), /export function parseAgentTodoItems/);
  // Popover 是唯一展开层：宿主使用无二级按钮的嵌入模式，完成态仍直接可见。
  const todoUsage = chipsSource().match(/<TodoList[\s\S]*?\/>/)?.[0];
  assert.ok(todoUsage);
  assert.match(todoUsage, /\bembedded\b/);
  assert.doesNotMatch(todoUsage, /collapseOnComplete|defaultOpen/);
  assert.match(todoUsage, /maxHeight=\{320\}/);
  assert.match(todoUsage, /className="rounded-none border-0 pr-7"/);
  // 外层 Popover 负责唯一的边框和圆角，避免出现两层不重合的角
  // （className 带 widget-popover 壁纸标记前缀，断言只约束宽度表达式部分）
  assert.match(chipsSource(), /PopoverContent[\s\S]*className="[^"]*w-\[min\(28rem/);

  assert.match(chipsSource(), /compact/);
  // 桌面紧凑宽度：28rem 上限 + Radix 实际可用宽度约束（留 12px 边界余量），
  // 不再依赖 100vw 推算，窄窗口时内容收敛而不是整体左移
  assert.match(
    chipsSource(),
    /w-\[min\(28rem,calc\(var\(--radix-popover-content-available-width\)_-_12px\)\)\]/,
  );
  // 只禁止实际 class 使用旧的 viewport 宽度规则，注释可以解释为什么移除它。
  assert.doesNotMatch(chipsSource(), /className="[^"]*100vw/);
  assert.doesNotMatch(chipsSource(), /className="[^"]*40rem/);
  // 与触发器保持可见间距（默认 sideOffset=4，此处显式 8）
  assert.match(chipsSource(), /sideOffset=\{8\}/);
  // 独立 h-8 关闭行已移除：不再产生顶部空白，关闭按钮改为宿主层非布局叠放
  assert.doesNotMatch(chipsSource(), /flex h-8 shrink-0 items-center justify-end/);
  assert.doesNotMatch(chipsSource(), /h-8 shrink-0/);
  assert.match(
    chipsSource(),
    /className="absolute right-1\.5 top-1\.5 z-10 rounded-md text-muted-foreground hover:text-foreground"/,
  );
  // 官方 TodoList 不接受 onDismiss：关闭按钮作为宿主层放在列表外部，官方结构不被改动
  assert.doesNotMatch(chipsSource(), /<TodoList[\s\S]*?onDismiss/);
  assert.match(chipsSource(), /variant="ghost"/);
  assert.match(chipsSource(), /t\("common\.close"\)/);
  // 旧的本地仿制组件已删除，不再残留于 session 目录
  assert.throws(() =>
    readFileSync("src/renderer/src/components/session/AgentTodoList.tsx"),
  );
});
