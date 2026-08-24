import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const removedFiles = [
  "src/renderer/src/components/app/BrowserPanel.tsx",
  "src/renderer/src/components/workspace/BrowserSurface.tsx",
  "src/main/browser/browserPanelWebviewHost.ts",
  "src/main/browser/browserSecurity.ts",
  "src/main/browser/externalProtocolRequests.ts",
];

const read = (filePath) => readFileSync(filePath, "utf8");

test("Browser Panel implementation files are removed", () => {
  for (const filePath of removedFiles) {
    assert.equal(existsSync(filePath), false, `${filePath} must not exist`);
  }
});

test("Browser Panel wiring is absent while controlled external links remain", () => {
  const main = read("src/main/index.ts");
  const ipc = read("src/shared/ipc.ts");
  const settings = read("src/shared/types/settings.ts");
  const app = read("src/renderer/src/App.tsx");
  const externalLinks = read("src/main/browser/externalLinks.ts");

  for (const source of [main, ipc, settings, app]) {
    for (const forbidden of [
      "configureBrowserPanelWebviewHost",
      "createExternalProtocolGateway",
      "appOpenInBrowser",
      "appConfirmExternalProtocol",
      "appRespondExternalProtocol",
      "useExternalProtocolConfirm",
      "requestBrowserNavigation",
      "drawer-rail-browser",
      "app.browser",
      "webviewTag: true",
      "<webview",
      "linkOpenMode",
      "LinkOpenMode",
    ]) {
      assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), forbidden);
    }
  }

  assert.match(externalLinks, /NON_HTTP_EXTERNAL_SCHEMES/);
  assert.match(externalLinks, /isAllowedSystemExternalProtocol/);
  assert.match(externalLinks, /openExternalLink/);
  assert.match(ipc, /appOpenExternal: "app:open-external"/);
});
