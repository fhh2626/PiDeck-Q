import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const skills = readFileSync("src/renderer/src/config/SkillsTab.tsx", "utf8");
const prompts = readFileSync("src/renderer/src/config/PromptsTab.tsx", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const rendererStyles = readFileSync("src/renderer/src/styles.css", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
const projectResources = readFileSync("src/renderer/src/components/app/ProjectResourcesModal.tsx", "utf8");
const workspaceStyles = readFileSync("src/renderer/src/styles/workspace.css", "utf8");
const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enCopy = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const tabs = readFileSync("src/renderer/src/components/ui-shadcn/tabs.tsx", "utf8");
const skillTableRow = skills.slice(skills.indexOf("function SkillTableRow"));

test("config shell defines compact density and crisp system typography", () => {
  assert.match(surfaces, /\.config-modal \[data-slot="button"\]/);
  assert.match(surfaces, /\.config-modal \[data-slot="input"\]/);
  // Windows/Electron 小字号中文需要保留子像素抗锯齿；config modal 不能强制 grayscale antialiasing。
  assert.match(surfaces, /\.config-modal \{[\s\S]*-webkit-font-smoothing: subpixel-antialiased/);
  assert.match(surfaces, /\.config-modal \{[\s\S]*text-rendering: auto/);
  assert.doesNotMatch(surfaces, /\.config-modal \{[\s\S]*-webkit-font-smoothing: antialiased;/);
  assert.match(surfaces, /\.config-nav-btn \{[\s\S]*font-size:\s*14px/);
  // 选中态随 Vertical Tabs 迁移：由 TabsTrigger data-[state=active] utility 承担
  assert.match(tabs, /data-\[state=active\]:bg-bg-panel/);
  assert.doesNotMatch(surfaces, /\.config-nav-btn\.active \{/);
  assert.match(foundation, /Segoe UI Variable Text/);
  assert.match(foundation, /Microsoft YaHei UI/);
  assert.doesNotMatch(foundation, /MiSans/);
  // 语言下拉的 "system" 选项位于常用设置 tab（CommonTab，自 SettingsModal 拆分）
  assert.match(commonTab, /value: "system"/);
  assert.doesNotMatch(rendererStyles, /styles\/lxgw-wenkai\.css/);
  assert.doesNotMatch(rendererStyles, /misans/i);
  assert.equal(existsSync("src/renderer/assets/fonts/misans"), false);
  assert.equal(existsSync("src/renderer/src/styles/misans"), false);
  assert.equal(existsSync("src/renderer/assets/fonts/lxgw-wenkai"), false);
  assert.equal(existsSync("src/renderer/src/styles/lxgw-wenkai.css"), false);
  assert.doesNotMatch(rendererStyles, /lxgw-wenkai/);
  assert.doesNotMatch(surfaces, /\.config-models-grid-header[\s\S]*font-weight: 650/);
  assert.match(configModal, /configModalSizeClass/);
  assert.match(configModal, /w-\[80vw\]/);
  assert.match(configModal, /max-w-\[80vw\]/);
  assert.match(configModal, /h-\[80vh\]/);
  assert.match(configModal, /sm:max-w-\[min\(1300px,80vw\)\]/);
  assert.match(configModal, /max-\[820px\]:flex-col/);
  assert.match(configModal, /max-\[820px\]:flex-row/);
  assert.match(settingsModal, /settingsModalSizeClass/);
  assert.match(settingsModal, /w-\[80vw\]/);
  assert.match(surfaces, /\.settings-modal \{[\s\S]*width: min\(1300px, 80vw\);[\s\S]*height: min\(850px, 80vh\);/);
  assert.match(surfaces, /\.config-modal \{[\s\S]*width: min\(1300px, 80vw\);[\s\S]*height: min\(850px, 80vh\);/);
});

test("project resources use one consistent shadcn management shell", () => {
  // 弹窗必须只有一套标题栏和一套 tab rail；重复 header 会造成截图中的空白与关闭按钮错位。
  assert.match(projectResources, /<DialogHeader className="[^"]*border-b/);
  assert.doesNotMatch(projectResources, /<header className="project-resources-header"/);
  assert.match(projectResources, /<Tabs\n\s+value=\{activeTab\}/);
  assert.match(projectResources, /<TabsList className="[^"]*w-full/);
  assert.match(projectResources, /from "\.\.\/ui-shadcn\/(?:card|alert|scroll-area)"/);
  assert.match(projectResources, /<Card(?:\s|>)/);
  assert.match(projectResources, /<Alert variant="destructive"/);
  assert.match(projectResources, /<ScrollArea className=/);

  // 视觉重排只能换容器；项目资源的创建、切换、编辑、启停、删除和刷新流程必须仍在页面中。
  for (const contract of [
    "createSkill",
    "createProjectPrompt",
    "toggleSkill",
    "toggleExtension",
    "confirmDelete",
    "openEditor",
    "refresh",
    "loadPrompts",
  ]) {
    assert.match(projectResources, new RegExp(`\\b${contract}\\b`));
  }
  // Prompt edit ownership moved to the shared hook; keep the actual launch,
  // project file adapter and dialog wiring protected, not the old function name.
  assert.match(projectResources, /const promptEditor = usePromptTemplateEditor\(/);
  assert.match(projectResources, /storage: createProjectPromptEditorStorage\(window\.piDesktop\.files\)/);
  assert.match(projectResources, /onClick=\{\(\) => void promptEditor\.open\(prompt\)\}/);
  assert.match(projectResources, /<PromptEditorDialog editor=\{promptEditor\}/);
});

test("project resource cards stack metadata and keep destructive actions discoverable", () => {
  // 卡片内容必须垂直排布；横向 flex 会把名称、状态和路径挤成截图中的一条线。
  assert.match(workspaceStyles, /\.project-resource-card > \.project-resource-info \{[^}]*display: grid/);
  assert.match(workspaceStyles, /\.project-skill-create \{[^}]*grid-row: 1 \/ span 2/);
  // 删除/编辑不能只依赖 hover，否则鼠标离开卡片或触屏设备上不可发现。
  assert.match(workspaceStyles, /\.project-resource-actions \{[^}]*opacity: 1/);
  assert.match(projectResources, /setDeleteTarget\(\{ kind: "skill"/);
  assert.match(projectResources, /setDeleteTarget\(\{ kind: "extension"/);
  assert.match(projectResources, /setDeleteTarget\(\{ kind: "prompt"/);
});

test("resource forms reserve label width and distinguish skill/prompt actions", () => {
  // 固定标签列避免中文字段名被压成竖排；按钮文案必须按资源类型区分。
  assert.match(projectResources, /grid-cols-\[4rem_minmax\(0,1fr\)\]/);
  assert.match(projectResources, /t\("projectResources\.createSkillAction"\)/);
  assert.match(projectResources, /t\("projectResources\.createPromptAction"\)/);
  assert.match(zhCopy, /"projectResources\.createSkillAction": "创建技能"/);
  assert.match(zhCopy, /"projectResources\.createPromptAction": "创建提示词"/);
  assert.match(enCopy, /"projectResources\.createSkillAction": "Create Skill"/);
  assert.match(enCopy, /"projectResources\.createPromptAction": "Create Prompt"/);
  assert.doesNotMatch(projectResources, /creatingPrompt \? t\("config\.creatingSkill"\)/);
});

test("skills and prompts use full-width tab rails with compact selected tabs", () => {
  assert.match(skills, /<TabsList className="w-full"/);
  assert.match(prompts, /<TabsList className="w-full"/);
  const tabs = readFileSync("src/renderer/src/components/ui-shadcn/tabs.tsx", "utf8");
  assert.match(tabs, /w-full items-center/);
  assert.match(tabs, /data-\[state=active\]:shadow-sm/);
  assert.match(tabs, /!text-\[color:var\(--color-text-secondary\)\]/);
});

test("skill list is not accidentally filtered by the new-skill destination", () => {
  assert.match(skills, /const visibleSkills = data\.skills;/);
  assert.doesNotMatch(skills, /const filteredSkills = data\.skills\.filter/);
});

test("skill table uses real aligned columns, not a colSpan card", () => {
  assert.match(skillTableRow, /<TableRow>/);
  assert.match(skillTableRow, /<TableCell className="min-w-0">/);
  assert.match(skillTableRow, /<TableCell className="whitespace-normal break-words/);
  assert.match(skillTableRow, /<TableCell className="text-right">/);
  // 操作按钮直接放在 TableCell 内，不再包一层可点击的卡片 button。
  assert.doesNotMatch(skillTableRow, /<button[\s\S]*skill-rename-inline[\s\S]*<Button/);
  // 位置选择改为 shadcn Select，不再使用自定义下拉弹层。
  // （远端 abb45b39 有意恢复默认高度：选择器仅显示相对路径、单行截断左对齐）
  assert.match(skills, /<SelectTrigger className="w-full">/);
  assert.doesNotMatch(skills, /skill-location-picker/);
});
