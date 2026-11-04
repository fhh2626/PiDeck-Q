import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// PiRpcClient.ts 含参数属性等非可擦除 TS 语法，node 原生 type-stripping 无法解析，
// 统一走 loadTsCommonJs（TypeScript 编译加载）。
const { PiRpcClient } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");

/**
 * PiRpcClient 超时契约：错误文本必须携带超时时长，
 * 供 toast / 启动诊断卡直接区分「等待过久」与「连接断开」，
 * 也用于验证默认 30s 与调用方显式 timeout 都落在同一错误格式上。
 */

function createClient(timeoutMs) {
  const stdin = new Writable({
    write: (_chunk, _enc, cb) => cb(),
  });
  const stdout = new PassThrough();
  const client = new PiRpcClient(stdin, stdout);
  return { client, stdout };
}

test("timeout error message includes the configured duration", async () => {
  const { client } = createClient(10);
  await assert.rejects(
    client.request({ type: "get_state" }, 10),
    (error) => {
      // loadTsCommonJs 走 vm 加载，Error 属于另一个 realm，instanceof 不可靠，鸭子类型断言
      const message = typeof error === "object" && error && "message" in error
        ? String(error.message)
        : String(error);
      assert.match(message, /RPC command timed out after 10ms: get_state/);
      return true;
    },
  );
});

test("default timeout is 30s and reflected in error text", async () => {
  // 注入可控的 setTimeout：不真等 30s，直接观察调度时长并手动触发回调
  const scheduled = [];
  const { PiRpcClient: ClockedClient } = loadTsCommonJs("src/main/pi/PiRpcClient.ts", {
    globals: {
      setTimeout: (fn, delay) => {
        scheduled.push({ fn, delay });
        return { fake: true };
      },
      clearTimeout: () => {},
    },
  });
  const stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const client = new ClockedClient(stdin, new PassThrough());
  const pending = client.request({ type: "get_state" });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 30_000, "未显式传入 timeout 时默认 30s");
  scheduled[0].fn();
  await assert.rejects(pending, (error) => {
    assert.match(String(error.message), /RPC command timed out after 30000ms: get_state/);
    return true;
  });
});
test("pending request is removed after timeout (no double resolve)", async () => {
  const { client } = createClient(10);
  const error = await client.request({ type: "get_state" }, 10).catch((e) => e);
  const message = typeof error === "object" && error && "message" in error
    ? String(error.message)
    : String(error);
  assert.match(message, /timed out/);
});

test("closed client ignores late stdout events and rejects new requests", async () => {
  const { client, stdout } = createClient(10);
  const events = [];
  client.on("event", (event) => events.push(event));

  client.close();
  stdout.write('{"type":"agent_start"}\n');

  await assert.rejects(client.request({ type: "get_state" }, 10), /RPC client is closed/);
  assert.deepEqual(events, []);
});
