import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { mapCachedMessageToEntryCandidates, normalizeMessageTextForMatch } = loadTsCommonJs(
  "src/main/pi/agentUtils.ts",
);

function cachedMessage(id, role) {
  return { id, role };
}

function entry(id, role) {
  return { id, role };
}

// mapCachedMessageToEntryCandidates 在 vm 沙箱里执行，返回对象原型与测试不同，
// assert.deepEqual 会因原型不等而误报，因此逐字段断言。
function assertUserMapping(actual, entryId) {
  assert.equal(actual?.role, "user");
  assert.equal(actual?.entryId, entryId);
}

function assertAssistantMapping(actual, candidateIds) {
  assert.equal(actual?.role, "assistant");
  assert.equal(actual?.candidateIds.length, candidateIds.length);
  candidateIds.forEach((id, index) => assert.equal(actual.candidateIds[index], id));
}

test("normalizeMessageTextForMatch collapses whitespace so block joins compare equal", () => {
  assert.equal(normalizeMessageTextForMatch("a  b\n c "), "a b c");
  assert.equal(normalizeMessageTextForMatch(""), "");
  // 缓存用 "\n\n" 拼接分块，文件侧可能是单换行：规范化后必须相等
  assert.equal(
    normalizeMessageTextForMatch("first\n\nsecond"),
    normalizeMessageTextForMatch("first\nsecond"),
  );
});

// abort 之后文件比缓存多一条空 assistant。旧的「按 user+assistant 总数从尾部对位」
// 会整体偏移一位，删除 a2a 时命中 a2b；按轮锚定后必须只返回同一轮的候选。
test("assistant mapping stays inside its own turn when the file has an extra aborted entry", () => {
  const cached = [
    cachedMessage("u1", "user"),
    cachedMessage("a1", "assistant"),
    cachedMessage("u2", "user"),
    cachedMessage("a2a", "assistant"),
  ];
  const entries = [
    entry("e-u1", "user"),
    entry("e-a1", "assistant"),
    entry("e-u2", "user"),
    entry("e-a2a", "assistant"),
    entry("e-a2b", "assistant"),
  ];

  assertAssistantMapping(
    mapCachedMessageToEntryCandidates(cached, entries, "a2a"),
    ["e-a2a", "e-a2b"],
  );
});

test("user mapping counts only users so extra assistants cannot shift it", () => {
  const cached = [
    cachedMessage("u1", "user"),
    cachedMessage("a1", "assistant"),
    cachedMessage("u2", "user"),
    cachedMessage("a2", "assistant"),
  ];
  const entries = [
    entry("e-u1", "user"),
    entry("e-a1", "assistant"),
    entry("e-a1x", "assistant"),
    entry("e-u2", "user"),
    entry("e-a2", "assistant"),
  ];

  assertUserMapping(mapCachedMessageToEntryCandidates(cached, entries, "u1"), "e-u1");
  assertUserMapping(mapCachedMessageToEntryCandidates(cached, entries, "u2"), "e-u2");
});

test("mapping tolerates a trimmed cache that no longer starts at the first turn", () => {
  const cached = [
    cachedMessage("u2", "user"),
    cachedMessage("a2", "assistant"),
    cachedMessage("u3", "user"),
    cachedMessage("a3", "assistant"),
  ];
  const entries = [
    entry("e-u1", "user"),
    entry("e-a1", "assistant"),
    entry("e-u2", "user"),
    entry("e-a2", "assistant"),
    entry("e-u3", "user"),
    entry("e-a3", "assistant"),
  ];

  assertUserMapping(mapCachedMessageToEntryCandidates(cached, entries, "u2"), "e-u2");
  assertAssistantMapping(
    mapCachedMessageToEntryCandidates(cached, entries, "a2"),
    ["e-a2"],
  );
});

test("assistant without a cached user anchor and unknown ids return undefined", () => {
  const cached = [cachedMessage("a0", "assistant"), cachedMessage("u1", "user")];
  const entries = [entry("e-a0", "assistant"), entry("e-u1", "user"), entry("e-a1", "assistant")];

  // 没有前置 user：调用方应退回「角色 + 正文」兜底，而不是猜一个条目
  assert.equal(mapCachedMessageToEntryCandidates(cached, entries, "a0"), undefined);
  // 缓存里不存在的消息
  assert.equal(mapCachedMessageToEntryCandidates(cached, entries, "nope"), undefined);
});

test("mapping returns undefined when the file has fewer turns than the cache claims", () => {
  const cached = [
    cachedMessage("u1", "user"),
    cachedMessage("a1", "assistant"),
    cachedMessage("u2", "user"),
    cachedMessage("a2", "assistant"),
  ];
  const entries = [entry("e-u2", "user"), entry("e-a2", "assistant")];

  assert.equal(mapCachedMessageToEntryCandidates(cached, entries, "u1"), undefined);
  assertUserMapping(mapCachedMessageToEntryCandidates(cached, entries, "u2"), "e-u2");
});

test("non message roles are ignored on both sides", () => {
  const cached = [
    cachedMessage("u1", "user"),
    cachedMessage("err1", "error"),
    cachedMessage("a1", "assistant"),
  ];
  const entries = [
    entry("e-u1", "user"),
    entry("e-sys", "system"),
    entry("e-a1", "assistant"),
  ];

  assertAssistantMapping(
    mapCachedMessageToEntryCandidates(cached, entries, "a1"),
    ["e-a1"],
  );
});
