import assert from "node:assert/strict";
import test from "node:test";
import { Cdp } from "./helpers/native2PackagedHost.mjs";

class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  reply(frame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
}

test("packaged CDP rejects outstanding commands when the target closes", async () => {
  const socket = new Socket();
  const client = new Cdp(socket, { timeoutMs: 25 });
  const command = client.send("Runtime.enable");
  socket.close();
  await assert.rejects(command, /closed/);
  assert.equal(client.pending.size, 0);
});

test("packaged CDP bounds an unresponsive target instead of hanging the package gate", async () => {
  const socket = new Socket();
  const client = new Cdp(socket, { timeoutMs: 20 });
  await assert.rejects(client.send("Runtime.enable"), /timed out.*Runtime.enable/);
  assert.equal(client.pending.size, 0);
  client.close();
});

test("packaged CDP settles a successful reply and rejects page exceptions", async () => {
  const socket = new Socket();
  const client = new Cdp(socket, { timeoutMs: 100 });
  const command = client.send("Runtime.enable");
  socket.reply({ id: socket.sent.at(-1).id, result: { enabled: true } });
  assert.deepEqual(await command, { enabled: true });
  const evaluation = client.evaluate("missing.value");
  socket.reply({ id: socket.sent.at(-1).id, result: {
    exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: missing is not defined" } },
  } });
  await assert.rejects(evaluation, /missing is not defined/);
  client.close();
});
