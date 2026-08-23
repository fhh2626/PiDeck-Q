import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const settingsTypes = readFileSync("src/shared/types/settings.ts", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
const gitModelsHook = readFileSync("src/renderer/src/components/app/settings/gitModels.ts", "utf8");
const fileSortControl = readFileSync("src/renderer/src/components/session/FileSortControl.tsx", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const projectEmptyState = readFileSync("src/renderer/src/components/session/ProjectEmptyState.tsx", "utf8");
const commandPicker = readFileSync("src/renderer/src/components/ui-shadcn/command-picker.tsx", "utf8");
const i18n = [
  readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
  readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
  readFileSync("src/shared/i18n/mainProcessCopy.ts", "utf8"),
].join("\n");

test("Git summary stores an explicit provider and model without a legacy fallback", () => {
  assert.match(settingsTypes, /gitCommitMessageProvider:\s*string/);
  assert.match(settingsTypes, /gitCommitMessageModel:\s*string/);
  assert.match(settingsStore, /gitCommitMessageProvider:\s*""/);
  assert.match(settingsStore, /gitCommitMessageModel:\s*""/);
  assert.match(gitIpc, /gitCommitMessageProvider\.trim\(\)/);
  assert.match(gitIpc, /gitCommitMessageModel\.trim\(\)/);
  assert.match(gitIpc, /git\.commitMessageModelRequired/);
});

test("Git summary selects the configured model while retaining the lightweight RPC flags", () => {
  assert.match(gitIpc, /type:\s*"set_model"[\s\S]*provider: model\.provider[\s\S]*modelId: model\.modelId/);
  for (const flag of [
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--thinking",
  ]) {
    assert.match(gitIpc, new RegExp(`"${flag}"`));
  }
  assert.match(gitIpc, /"--thinking",\s*"off"/);
  assert.match(gitIpc, /provider\/model 变化时必须重启轻量进程/);
  assert.match(gitIpc, /if \(genProcess === childProcess\) stopGenProcess\(\)/);
});

test("File sorting leaves hover state to Radix DropdownMenu", () => {
  assert.match(fileSortControl, /<DropdownMenu open=\{open\} onOpenChange=\{setOpen\}>/);
  assert.doesNotMatch(fileSortControl, /onMouseEnter|onMouseLeave|closeTimerRef/);
});

test("Shared model picker keeps one model line and supports collapse and selected-item positioning", () => {
  assert.match(composerComponents, /<CommandPickerGroup id=\"favorites\"/);
  assert.doesNotMatch(composerComponents, /picker-palette-label.*model\.name/);
  assert.match(commandPicker, /showGroupActions/);
  assert.match(commandPicker, /allCollapsed \? expandedGroups\.has\(props\.id\)/);
  assert.match(commandPicker, /if \(allCollapsed\)/);
  assert.match(composerComponents, /value=\{currentModelKey\}/);
  assert.match(composerComponents, /value=\{props\.currentMode\}/);
  assert.match(composerComponents, /value=\{props\.current\}/);
  assert.match(commandPicker, /search\.trim\(\) \? <CommandEmpty/);
  assert.match(commandPicker, /scrollIntoView\(\{ block: \"center\" \}\)/);
  // 启动配置选择统一由输入框底栏（ComposerArea/ComposerBottomBar）承担：
  // 空态页不得再出现第二套模型/思考级别选择器（防止双实现回归）
  assert.match(projectEmptyState, /<ModelPicker/);
  assert.match(projectEmptyState, /<ThinkingPicker/);
});


const registerBackendRpc = readFileSync("src/main/backend/registerBackendRpc.ts", "utf8");

test("Git summary settings expose the shared command model picker", () => {
  // Git 分区与模型选择器位于常用设置 tab（CommonTab）；数据源 hook 独立成文件（gitModels.ts，
  // 以便 CommonTab lazy 加载）——listModels 调用在 hook 里
  assert.match(gitModelsHook, /projects\.listModels\(\)/);
  assert.match(commonTab, /ModelPicker/);
  assert.match(commonTab, /gitModelPickerOpen/);
  assert.doesNotMatch(commonTab, /<datalist/);
  assert.doesNotMatch(commonTab, /git-commit-message-providers/);
  assert.doesNotMatch(commonTab, /git-commit-message-models/);
  assert.match(commonTab, /gitCommitMessageProvider/);
  assert.match(commonTab, /gitCommitMessageModel/);
  assert.equal(i18n.match(/"settings\.gitCommitMessageModel":/g)?.length, 2);
  assert.equal(i18n.match(/"settings\.gitCommitMessageModelUnset":/g)?.length, 2);
  assert.match(i18n, /git\.commitMessageModelRequired/);
});

test("Git IPC receives the localized settings guidance from the main process", () => {
  assert.match(gitIpc, /mainCopy: \(key: string/);
  assert.match(registerBackendRpc, /registerGitIpc\(router,\s*\{[\s\S]*mainCopy: mainCopy/);
});
