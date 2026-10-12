import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const settings = (port) => ({
 webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: port,
 webServiceAccessToken: "a".repeat(32),
});

/** 实际 HTTP listener 使用系统分配的端口，不以随机端口或检查后释放的端口参与竞争。 */
function createFixture(failFirstListen = false) {
 const servers = [];
 const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", {
  stubs: {
   "node:http": {
    createServer(handler) {
     const server = http.createServer(handler);
     const listen = server.listen.bind(server);
     const fail = failFirstListen && servers.length === 0;
     server.listen = (_port, host, callback) => {
      if (fail) {
       queueMicrotask(() => server.emit("error", Object.assign(new Error("controlled listen failure"), { code: "EADDRINUSE" })));
       return server;
      }
      return listen(0, host, callback);
     };
     servers.push(server);
     return server;
    },
    request: http.request,
   },
  },
 });
 const manager = new WebServiceManager({ subscribePiEvents: () => () => undefined, getSessionIdForAgent: () => undefined });
 // 独立兜底清理：即使断言失败或 manager 丢失 listener，也关闭本测试拥有的所有 server。
 async function cleanup() {
  try { await manager.stop(); }
  finally {
   await Promise.all(servers.map(server => new Promise((resolve) => {
    server.closeAllConnections();
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
   })));
  }
 }
 return { manager, servers, cleanup };
}

test("concurrent web service starts do not leave an untracked listener", async () => {
 const { manager, servers, cleanup } = createFixture();
 try {
  const settled = await Promise.allSettled([manager.applySettings(settings(12345)), manager.restart(settings(12346))]);
  assert.equal(settled.every(result => result.status === "fulfilled"), true);
  await manager.stop();
  assert.ok(servers.length >= 1);
  assert.equal(servers.every(server => !server.listening), true);
 } finally { await cleanup(); }
});

test("web lifecycle queue accepts a restart after a controlled listen failure", async () => {
 const { manager, servers, cleanup } = createFixture(true);
 try {
  const settled = await Promise.allSettled([manager.applySettings(settings(12345)), manager.restart(settings(12346))]);
  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[1].status, "fulfilled");
  assert.equal(servers[1].listening, true);
  await manager.stop();
  assert.equal(servers.every(server => !server.listening), true);
 } finally { await cleanup(); }
});
