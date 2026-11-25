/**
 * Git 面板非 git 仓库轮询暂停契约测试。
 *
 * 非仓库或未安装 Git 时跳过周期性 status 和 fetch，避免重复启动失败的命令。
 * 首次加载和显式刷新仍可发现 Git 恢复。隐藏与恢复的计时行为由 visiblePoll.test.mjs 验证。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");

test("非 git 仓库 / 未安装 git 时跳过周期性状态扫描，仍可首次加载与恢复", () => {
  assert.match(source, /useVisiblePoll\(props\.projectId, 15_000, \(cause, whenVisible\) => \{\s*if \(cause === "interval" && \(notAGitRepo \|\| gitNotInstalled\)\) return;\s*void refresh\(cause !== "mount", cause === "visible" \? whenVisible : undefined\);/);
});

test("无有效仓库时跳过周期性 fetch，项目切换后允许新仓库首次加载", () => {
  const fetchBlock = source.slice(source.indexOf("useVisiblePoll(props.fetch"), source.indexOf("const toggleResource"));
  assert.match(fetchBlock, /5 \* 60_000/);
  assert.match(fetchBlock, /if \(cause !== "mount" && \(notAGitRepo \|\| gitNotInstalled\)\) return;\s*void refreshAheadBehind\(\);\s*\}, true, false\)/);
});

test("refresh 成功路径清除仓库/工具标记（git init 或安装 git 后自动恢复轮询）", () => {
  // setGroups(next) 之后紧接着清除两个标记
  const successBlock = source.slice(source.indexOf("setGroups(next);"));
  const afterGroups = successBlock.slice(0, successBlock.indexOf("} catch (caught)"));
  assert.match(afterGroups, /setNotAGitRepo\(false\);/);
  assert.match(afterGroups, /setGitNotInstalled\(false\);/);
});

test("静默失败同样置位非仓库/未安装标记（置位逻辑不在 !silent 分支内）", () => {
  // catch 块中置位先于 !silent UI 清理分支执行
  const catchBlock = source.slice(
    source.indexOf("} catch (caught) {"),
    source.indexOf("} finally {"),
  );
  const silentGuard = catchBlock.indexOf("if (!silent) {");
  assert.ok(silentGuard >= 0, "应存在 !silent 分支");
  // 置位语句必须出现在 !silent 之前——silent 轮询失败也要能停住轮询
  const beforeSilent = catchBlock.slice(0, silentGuard);
  assert.match(beforeSilent, /setNotAGitRepo\(true\);/);
  assert.match(beforeSilent, /setGitNotInstalled\(true\);/);
});

test("手动刷新按钮保留（用户 git init 后可立即手动恢复）", () => {
  // 手动刷新入口仍在（非 silent 刷新）
  assert.match(source, /void refresh\(\);/);
});
