import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Vision 桥配置刷新契约（Review P2）：
// visionGetConfig 成功但 config 为空（配置被删除/失效）时必须清掉 stale 值；
// 只有成功且非空才 setConfig(res.config) 的旧写法会让已挂载 Composer 永远用旧配置。

const hook = readFileSync("src/renderer/src/hooks/useVisionBridgeConfig.ts", "utf8");

test("useVisionBridgeConfig clears stale config when fetch resolves null", () => {
  assert.match(
    hook,
    /setConfig\(res\?\.config \?\? null\)/,
    "成功返回空 config 时必须 setConfig(null)，不得保留旧值",
  );
  // 旧 fail-open 写法不得回归
  assert.doesNotMatch(hook, /if \(active && res\?\.config\)/);
  // 失败路径仍清空
  assert.match(hook, /\.catch\(\(\) => \{[\s\S]*?setConfig\(null\)/);
  // revision 依赖保留：visionDraft 保存成功后递增 revision 触发重取
  assert.match(hook, /visionConfigRevisionAtom/);
  assert.match(hook, /revision\]/);
});
