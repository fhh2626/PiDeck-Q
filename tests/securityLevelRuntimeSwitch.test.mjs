import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 安全级别运行中切换（issue #146 延伸）。
 *
 * 与思考强度不同，安全级别不是 pi 的生成参数：
 * - 切换 = 写 security-policy.json 策略快照（SecurityStore.writeSnapshot）；
 * - pi-deck-security-gate 扩展在每次工具调用时重新读取并验证快照，即「下一次工具调用生效」；
 * - 因此没有「下一轮才生效」的延迟语义，UI 只需放开运行中禁用，无需 pending 指示。
 */
test("契约: SecurityLevelMenu 运行中不再置灰（仅 Agent 启动中禁用）", () => {
  const area = readFileSync(
    "src/renderer/src/components/session/ComposerArea.tsx",
    "utf8",
  );
  // 安全按钮只被启动中禁用；isBusy（运行/流式）时仍可切换
  assert.match(
    area,
    /<SecurityLevelMenu sessionId=\{props\.sessionId\} disabled=\{composer\.isStarting\} \/>/,
  );
  // 模板/附件仍走全局 busy 禁用；思考与模型已单独放开运行中
  assert.match(
    area,
    /disabled=\{composer\.isBusy \|\| composer\.isStarting\}/,
  );
  assert.match(area, /modelDisabled=\{composer\.isStarting\}/);
});

test("契约: SecurityLevelMenu 自身仍以 props.disabled 为准（不做运行态特判）", () => {
  const menu = readFileSync(
    "src/renderer/src/components/session/SecurityLevelMenu.tsx",
    "utf8",
  );
  // 按钮禁用 = 外部传入 disabled 或保存中；菜单项在 enabled=false 时禁用
  assert.match(menu, /disabled=\{props\.disabled \|\| saving\}/);
  assert.match(menu, /disabled=\{!enabled \|\| saving\}/);
});

test("契约: 主进程写快照链路无 busy 校验（切换即时生效）", () => {
  const ipc = readFileSync("src/main/ipc/securityIpc.ts", "utf8");
  // handler 只做输入校验，不检查会话运行状态
  assert.doesNotMatch(ipc, /isBusy|isStreaming|runtime/);
  const store = readFileSync("src/main/security/SecurityStore.ts", "utf8");
  assert.match(store, /writeSnapshot/);
  assert.match(store, /security-policy\.json/);
});
