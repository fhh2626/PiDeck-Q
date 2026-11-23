import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const parserSandbox = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync("src/shared/sessionDeleteResponse.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, parserSandbox);

function load(payload, requests) {
  const source = readFileSync("src/renderer/src/browserApi.ts", "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = {
    exports: {},
    require: (name) => name.endsWith("/sessionDeleteResponse") ? parserSandbox.exports
      : name === "./i18n" ? { t: (key) => key } : { createPreviewApi: () => ({ projects: {}, sessions: {}, settings: {} }) },
    window: { setInterval: () => 1, clearInterval: () => {} },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, statusText: "OK", json: async () => url === "/api/state" ? { projects: [], sessions: [], runtimes: [], messagesBySession: {} } : payload };
    },
  };
  vm.runInNewContext(output, sandbox);
  return sandbox.exports.createBrowserApi();
}

test("browser deletion forwards explicit permanent authorization", async () => {
  const requests = [];
  const api = load({ deleted: true }, requests);
  assert.equal(await api.sessions.deleteRecord("id /", { permanent: true }), true);
  assert.equal(requests[0].url, "/api/sessions/id%20%2F/delete");
  assert.equal(requests[0].init.body, '{"permanent":true}');
});

test("browser deletion accepts only typed deletion results", async () => {
  for (const payload of [{ deleted: null }, { deleted: { status: "unexpected" } }, { deleted: { status: "trash-failed", extra: true } }, {}, { deleted: 1 }]) {
    const api = load(payload, []);
    await assert.rejects(api.sessions.deleteRecord("id"), /Invalid.*delet/i);
  }
  for (const deleted of [true, false, { status: "trash-failed" }]) {
    const requests = [];
    const api = load({ deleted }, requests);
    assert.equal(JSON.stringify(await api.sessions.deleteRecord("id")), JSON.stringify(deleted));
    assert.equal(requests[0].init.body, "{}");
    assert.equal(requests.filter((request) => request.url === "/api/state").length, typeof deleted === "boolean" ? 1 : 0);
  }
});
