import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { copyingBuffer } from "./helpers/performanceFixtures.mjs";

function encode(value) {
  const data = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(data.length + 4);
  frame.writeUInt32LE(data.length); data.copy(frame, 4); return frame;
}

/** Control TCP chunk boundaries without changing the public bridge handshake/API. */
async function harness() {
  const metrics = { copied: 0 };
  let socket;
  class FakeSocket extends EventEmitter {
    writableLength = 0;
    write(data) {
      const frame = JSON.parse(data.subarray(4).toString());
      if (frame.type === "hello") queueMicrotask(() => this.emit("data", encode({ type: "hello", ok: true })));
      return true;
    }
    destroy() { this.emit("close"); }
  }
  const { HostBridge } = loadTsCommonJs("src/native-node/host/HostBridge.ts", {
    globals: { Buffer: copyingBuffer(metrics) },
    stubs: { "node:net": { connect() {
      socket = new FakeSocket(); setImmediate(() => socket.emit("connect")); return socket;
    } } },
  });
  const bridge = await HostBridge.connect(1, "fixture-token");
  metrics.copied = 0;
  return { bridge, socket, metrics };
}

for (const size of [1, 4]) {
  test(`${size} MiB fragmented host event uses linear copying and preserves content`, async () => {
    const { bridge, socket, metrics } = await harness();
    const payload = "文😀".repeat(Math.ceil(size * 1024 * 1024 / 7));
    const frame = encode({ type: "event", name: "fixture", payload });
    const values = []; bridge.on("fixture", (value) => values.push(value));
    try {
      for (let i = 0; i < frame.length; i += 16 * 1024) socket.emit("data", frame.subarray(i, i + 16 * 1024));
      assert.equal(values.length, 1); assert.equal(values[0], payload);
      assert.ok(metrics.copied <= frame.length * 2, `copied ${metrics.copied} for ${frame.length} bytes`);
    } finally { bridge.close(); }
  });
}

test("split headers and coalesced payloads deliver UTF-8 frames exactly once", async () => {
  const { bridge, socket } = await harness(); const values = [];
  bridge.on("fixture", (value) => values.push(value));
  const frame = Buffer.concat([encode({ type: "event", name: "fixture", payload: "😀中文" }), encode({ type: "event", name: "fixture", payload: "next" })]);
  try {
    for (let i = 0; i < 3; i++) socket.emit("data", frame.subarray(i, i + 1));
    socket.emit("data", frame.subarray(3));
    assert.deepEqual(values, ["😀中文", "next"]);
  } finally { bridge.close(); }
});

test("oversized header rejects pending RPC and closes once without accepting later frames", async () => {
  const { bridge, socket } = await harness(); let fatal = 0; let events = 0;
  bridge.onFatal(() => fatal++); bridge.on("fixture", () => events++);
  const rejected = assert.rejects(bridge.request("fixture", {}), /exceeds 32 MB/);
  const header = Buffer.alloc(4); header.writeUInt32LE(32 * 1024 * 1024 + 1);
  try {
    socket.emit("data", header);
    socket.emit("data", encode({ type: "event", name: "fixture", payload: "late" }));
    await rejected;
    assert.equal(fatal, 1); assert.equal(events, 0);
  } finally { bridge.close(); }
});
