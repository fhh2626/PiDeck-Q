import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveChatSessionBootstrap } = loadTsCommonJs(
  "src/renderer/src/utils/chatSessionBootstrap.ts",
);

function resolve(input) {
  // The TypeScript loader executes modules in a VM realm, so normalize the
  // returned record before comparing it with Node's assertion realm.
  return JSON.parse(JSON.stringify(resolveChatSessionBootstrap(input)));
}

test("Chat bootstrap loads a collapsed catalog, then shows the unified guide page", () => {
	assert.deepEqual(resolve({
		isChatProject: true,
		catalogStatus: "idle",
	}), { kind: "load" });
	assert.deepEqual(resolve({
		isChatProject: true,
	}), { kind: "load" });
	assert.deepEqual(resolve({
		isChatProject: true,
		catalogStatus: "error",
	}), { kind: "load" });
	assert.deepEqual(resolve({
		isChatProject: true,
    catalogStatus: "loading",
  }), { kind: "wait" });
  assert.deepEqual(resolve({
    isChatProject: true,
    catalogStatus: "ready",
  }), { kind: "none" });
});

test("Chat bootstrap never replaces an existing selection or non-Chat project", () => {
  assert.deepEqual(resolve({
    isChatProject: true,
    currentSessionId: "selected",
    catalogStatus: "idle",
  }), { kind: "none" });
  assert.deepEqual(resolve({
    isChatProject: true,
    currentSessionId: "selected",
    catalogStatus: "ready",
  }), { kind: "none" });
  assert.deepEqual(resolve({
    isChatProject: false,
    catalogStatus: "idle",
  }), { kind: "none" });
  assert.deepEqual(resolve({
    isChatProject: false,
    catalogStatus: "ready",
  }), { kind: "none" });
});

