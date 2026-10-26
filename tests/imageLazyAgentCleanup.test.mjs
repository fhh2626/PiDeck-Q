import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 第二批内存优化契约：消息图片按需解码 + agentId 维度 atomFamily 随退出释放
const surface = [
	readFileSync("src/renderer/src/components/session/MessageImage.tsx", "utf8"),
	readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8"),
].join("\n");
const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

test("message images decode lazily via IntersectionObserver", () => {
  // base64 data URL 字符串无法省（已在消息对象），但解码位图是内存大头：
  // 视口外不设 src（不解码），进入视口（200px 提前量）才挂载；占位高度防滚动跳动。
  assert.match(surface, /function MessageImage\(/);
  assert.match(surface, /src=\{inView \? props\.src : undefined\}/);
  assert.match(surface, /rootMargin: \"200px\"/);
  assert.match(surface, /decoding=\"async\"/);
  assert.match(surface, /placeholderClass=\"min-h-24\"/);
  // 图片预览弹层不受影响（用户主动打开时必须即时显示）
  assert.match(surface, /src={`data:\$\{props\.image\.mimeType\};base64,\$\{props\.image\.data\}`}/);
});

test("agentId atom families are released on agent exit", () => {
  // Exercise reclamation, not the old (unreachable) inventory-array branch's source text.
  // The real single-object bridge and freshness guard are covered by rendererAnonymousDetachCleanup.
  const families = [atoms.agentByIdAtomFamily, atoms.runtimeCapabilityByAgentIdAtomFamily, atoms.sessionIdByRuntimeAgentIdAtomFamily];
  const old = families.map(f => f("exited"));
  const retained = families.map(f => f("alive"));
  createStore().set(atoms.agentExitedAtom, "exited");
  families.forEach((family, index) => {
    assert.notEqual(family("exited"), old[index]);
    assert.equal(family("alive"), retained[index]);
  });
});
