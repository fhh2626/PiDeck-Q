import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  applyModelThinkingSupport,
  clampThinkingLevelForModel,
  collectModelThinkingSupport,
  findModelThinkingSupport,
  isExtendedThinkingLevel,
  modelThinkingSupportFromMap,
  modelThinkingSupportKey,
  noModelThinkingSupport,
} = loadTsCommonJs("src/shared/thinkingLevelSupport.ts");

const { decorateModelsWithThinkingSupport, resolveModelThinkingSupport } = loadTsCommonJs(
  "src/main/pi/modelThinkingSupport.ts",
);

// vm realm 对象与测试 realm 原型不同，deepStrictEqual/Map 比较统一走 JSON。
function asJson(value) {
  return JSON.parse(JSON.stringify(value));
}

test("modelThinkingSupportFromMap only accepts xhigh/max declarations", () => {
  assert.deepEqual(asJson(modelThinkingSupportFromMap({ xhigh: "xhigh", max: "max" })), {
    xhigh: true,
    max: true,
  });
  // 交叉映射（xhigh→max）在配置页也是勾选状态，仍算支持
  assert.deepEqual(asJson(modelThinkingSupportFromMap({ xhigh: "max" })), {
    xhigh: true,
    max: false,
  });
  // 损坏/旧数据不能当成支持
  assert.deepEqual(asJson(modelThinkingSupportFromMap({ xhigh: null, max: "high" })), {
    xhigh: false,
    max: false,
  });
  assert.deepEqual(asJson(modelThinkingSupportFromMap(undefined)), asJson(noModelThinkingSupport()));
  assert.deepEqual(asJson(modelThinkingSupportFromMap([])), asJson(noModelThinkingSupport()));
});

test("collectModelThinkingSupport indexes models.json providers case-insensitively", () => {
  const support = collectModelThinkingSupport({
    providers: {
      OpenAI: {
        models: [
          { id: "Reasoning-Model", thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
          { id: "plain-model" },
          // 显式 reasoning:false：pi 只支持 off，残留映射也要清零
          { id: "no-reasoning", reasoning: false, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
          { id: "", thinkingLevelMap: { xhigh: "xhigh" } },
          "not-a-model",
        ],
      },
      broken: { models: "not-an-array" },
      alsoBroken: null,
    },
  });

  assert.deepEqual(asJson(support.get("openai\u0000reasoning-model")), {
    xhigh: true,
    max: true,
  });
  assert.deepEqual(asJson(support.get("openai\u0000plain-model")), {
    xhigh: false,
    max: false,
  });
  assert.deepEqual(asJson(support.get("openai\u0000no-reasoning")), asJson(noModelThinkingSupport()));
  assert.equal(support.has("openai\u0000"), false);
  assert.equal(support.size, 3);
  assert.equal(modelThinkingSupportKey("OpenAI", "Reasoning-Model"), "openai\u0000reasoning-model");
});

test("applyModelThinkingSupport decorates every model without mutating the source objects", () => {
  const models = [
    { provider: "openai", id: "reasoning-model", name: "Reasoning" },
    { provider: "openai", id: "plain-model" },
    { provider: "openai", id: "no-reasoning", reasoning: false },
  ];
  const support = collectModelThinkingSupport({
    providers: {
      openai: {
        models: [
          { id: "reasoning-model", thinkingLevelMap: { xhigh: "xhigh" } },
          { id: "no-reasoning", reasoning: false, thinkingLevelMap: { xhigh: "xhigh" } },
        ],
      },
    },
  });

  const decorated = applyModelThinkingSupport(models, support);

  assert.deepEqual(asJson(decorated), [
    {
      provider: "openai",
      id: "reasoning-model",
      name: "Reasoning",
      thinkingLevels: { xhigh: true, max: false },
    },
    {
      provider: "openai",
      id: "plain-model",
      thinkingLevels: { xhigh: false, max: false },
    },
    {
      provider: "openai",
      id: "no-reasoning",
      reasoning: false,
      thinkingLevels: { xhigh: false, max: false },
    },
  ]);
  // 原对象保持干净：模型列表缓存不能被注入字段污染
  assert.equal("thinkingLevels" in models[0], false);
});

test("clampThinkingLevelForModel downgrades only unsupported extended levels", () => {
  assert.equal(clampThinkingLevelForModel("xhigh", { xhigh: false, max: true }), "high");
  assert.equal(clampThinkingLevelForModel("max", { xhigh: true, max: false }), "high");
  assert.equal(clampThinkingLevelForModel("xhigh", { xhigh: true, max: false }), "xhigh");
  assert.equal(clampThinkingLevelForModel("max", { xhigh: false, max: true }), "max");
  // 基础档位不受影响；无档位信息时原样返回
  for (const level of ["off", "minimal", "low", "medium", "high"]) {
    assert.equal(clampThinkingLevelForModel(level, noModelThinkingSupport()), level);
  }
  assert.equal(clampThinkingLevelForModel(undefined, noModelThinkingSupport()), undefined);
});

test("findModelThinkingSupport matches case-insensitively and treats unknown models as unsupported", () => {
  const models = [
    {
      provider: "OpenAI",
      id: "Reasoning-Model",
      thinkingLevels: { xhigh: true, max: true },
    },
  ];

  assert.deepEqual(asJson(findModelThinkingSupport(models, "openai", "reasoning-model")), {
    xhigh: true,
    max: true,
  });
  assert.deepEqual(asJson(findModelThinkingSupport(models, "openai", "unknown")), asJson(noModelThinkingSupport()));
  assert.deepEqual(asJson(findModelThinkingSupport(models, undefined, "reasoning-model")), asJson(noModelThinkingSupport()));
  assert.equal(isExtendedThinkingLevel("xhigh"), true);
  assert.equal(isExtendedThinkingLevel("high"), false);
});

test("decorateModelsWithThinkingSupport reads models.json and fails closed", async () => {
  const models = [
    { provider: "openai", id: "reasoning-model" },
    { provider: "openai", id: "plain-model" },
  ];
  const config = {
    getModelsConfig: async () => ({
      parsed: {
        providers: {
          openai: {
            models: [{ id: "reasoning-model", thinkingLevelMap: { xhigh: "max" } }],
          },
        },
      },
    }),
  };

  assert.deepEqual(asJson(await decorateModelsWithThinkingSupport(models, config)), [
    { provider: "openai", id: "reasoning-model", thinkingLevels: { xhigh: true, max: false } },
    { provider: "openai", id: "plain-model", thinkingLevels: { xhigh: false, max: false } },
  ]);
  // 读取失败：不能把「未知」当支持，否则选择器会出现实际不被 pi 接受的档位
  assert.deepEqual(
    asJson(await decorateModelsWithThinkingSupport(models, {
      getModelsConfig: async () => {
        throw new Error("models.json unreadable");
      },
    })),
    [
      { provider: "openai", id: "reasoning-model", thinkingLevels: { xhigh: false, max: false } },
      { provider: "openai", id: "plain-model", thinkingLevels: { xhigh: false, max: false } },
    ],
  );
});

test("resolveModelThinkingSupport returns the declaration for one model", async () => {
  const config = {
    getModelsConfig: async () => ({
      parsed: {
        providers: {
          openai: {
            models: [{ id: "reasoning-model", thinkingLevelMap: { xhigh: "xhigh", max: "max" } }],
          },
        },
      },
    }),
  };
  assert.deepEqual(asJson(await resolveModelThinkingSupport(config, "openai", "reasoning-model")), {
    xhigh: true,
    max: true,
  });
  // 可读但未声明：明确按不支持处理（触发 high 降级）
  assert.deepEqual(asJson(await resolveModelThinkingSupport(config, "openai", "other")), asJson(noModelThinkingSupport()));
  // 不可读：返回 undefined（未知），调用方不得据此改掉用户偏好
  assert.equal(
    await resolveModelThinkingSupport({
      getModelsConfig: async () => {
        throw new Error("models.json unreadable");
      },
    }, "openai", "reasoning-model"),
    undefined,
  );
  // JSON 损坏：parsed 是 fallback，同样视为未知而不是「未声明」
  assert.equal(
    await resolveModelThinkingSupport({
      getModelsConfig: async () => ({
        parsed: { providers: {} },
        diagnostic: { message: "Unexpected token" },
      }),
    }, "openai", "reasoning-model"),
    undefined,
  );
  // 文件存在但读取失败（权限/IO）：同样视为未知，不能降级用户偏好
  assert.equal(
    await resolveModelThinkingSupport({
      getModelsConfig: async () => ({
        parsed: { providers: {} },
        readError: true,
      }),
    }, "openai", "reasoning-model"),
    undefined,
  );
});
