import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    setTimeout,
    clearTimeout,
  }, { filename: filePath });
  return module.exports;
}

function loadCoordinator() {
  const identity = compileModule("src/shared/sessionIdentity.ts");
  // shared/askQuestion 是值导入（batch 表单 normalizer），同样走 TS 编译；
  // 它自己的 import 全部是 import type（transpile 后擦除），无需再映射。
  const askQuestion = compileModule("src/shared/askQuestion.ts");
  return compileModule("src/main/sessions/SessionRuntimeCoordinator.ts", {
    "../../shared/sessionIdentity": identity,
    "../../shared/askQuestion": askQuestion,
  });
}

test("session performance instrumentation keeps activation and dispatch phase markers", () => {
  const source = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
  assert.match(source, /Prompt pipeline started/);
  assert.match(source, /Runtime activation started/);
  assert.match(source, /Runtime activation completed/);
  assert.match(source, /Prompt dispatch started/);
  assert.match(source, /Prompt dispatch completed/);
  assert.match(source, /activationMs/);
  assert.match(source, /dispatchMs/);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function catalogEntry(overrides = {}) {
  return {
    id: "session-1",
    projectId: "project-1",
    title: "Session 1",
    source: "pi",
    environment: "native",
    status: "draft",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createHarness(options = {}) {
  const entry = catalogEntry(options.entry);
  const calls = {
    create: 0,
    /** agents.create 收到的入参列表（断言会话身份/sessionPath 透传用） */
    createInputs: [],
    restart: 0,
    stop: 0,
	abort: 0,
	compact: 0,
	runtimeState: 0,
	commands: 0,
	messages: 0,
	exportHtml: 0,
	editMessage: 0,
	deleteMessage: 0,
	prepareResend: 0,
    setModel: 0,
    setThinking: 0,
    publishRuntimeState: 0,
	refreshSessionIdentity: 0,
	update: 0,
    attach: 0,
    send: 0,
    uiResponse: 0,
  };
  const tabs = options.tabs ? [...options.tabs] : [];
  const entriesMap = options.entries
    ? new Map(options.entries.map((e) => [e.id, catalogEntry(e)]))
    : new Map([[entry.id, entry]]);
  const catalog = {
    get: (sessionId) => {
      const e = entriesMap.get(sessionId);
      return e ? { ...e } : undefined;
    },
    getRecord: (sessionId) => {
      const e = entriesMap.get(sessionId);
      return e ? {
        ...e,
        preview: "",
        messageCount: 0,
      } : undefined;
    },
    update: async (sessionId, patch) => {
      calls.update += 1;
      const e = entriesMap.get(sessionId) ?? entry;
      Object.assign(e, patch);
      return { ...e };
    },
    attachRuntime: async (input) => {
      calls.attach += 1;
      const e = entriesMap.get(input.sessionId) ?? entry;
      e.filePath = input.filePath;
      e.status = input.filePath ? "active" : e.status;
    },
  };
  const agents = {
    list: () => tabs,
    getStartupTimeoutMs: () => options.startupTimeoutMs ?? 60_000,
	getMessages: (agentId) => {
	  calls.messages += 1;
	  if (options.getMessages) return options.getMessages(agentId);
	  return [{ id: "message-1", role: "assistant", text: agentId, timestamp: 1 }];
	},
    create: async (input) => {
      calls.create += 1;
      calls.createInputs.push(input);
      if (options.createDelay) {
        await new Promise((resolve) => setTimeout(resolve, options.createDelay));
      }
      const tab = options.createdTab ?? {
        id: "agent-1",
        projectId: input.projectId,
        cwd: "C:/project",
        title: input.title ?? "Session 1",
        status: "idle",
        sessionId: "pi-session-1",
        sessionPath: input.sessionPath ?? "C:/sessions/session-1.jsonl",
        sessionEnvironment: input.environment,
        sessionSource: input.source,
        wslDistro: input.wslDistro,
        wslUser: input.wslUser,
        importedSourceId: input.importedSourceId,
        createdAt: 1,
      };
      tabs.push(tab);
      return tab;
    },
    restart: async (agentId) => {
      calls.restart += 1;
      const index = tabs.findIndex((tab) => tab.id === agentId);
      const previous = index >= 0 ? tabs.splice(index, 1)[0] : undefined;
      const tab = options.restartedTab ?? {
        ...previous,
        id: "agent-restarted",
        status: "idle",
        createdAt: 2,
      };
      tabs.push(tab);
      return tab;
    },
    stop: async (agentId) => {
      calls.stop += 1;
      const index = tabs.findIndex((tab) => tab.id === agentId);
      if (index >= 0) tabs.splice(index, 1);
    },
    abort: async () => {
      calls.abort += 1;
      if (options.abortError) throw new Error(options.abortError);
    },
    compact: async () => {
      calls.compact += 1;
      return options.runtimeState ?? { isStreaming: false };
    },
    getRuntimeState: async () => {
      calls.runtimeState += 1;
      return options.runtimeState ?? { isStreaming: false };
    },
    getCommands: async () => {
      calls.commands += 1;
      return options.commands ?? [{ name: "compact" }];
    },
    exportHtml: async () => {
      calls.exportHtml += 1;
      return { path: "C:/export.html" };
    },
    editMessage: async (...args) => {
      calls.editMessage += 1;
      if (options.editMessage) return options.editMessage(...args);
    },
    deleteMessage: async (...args) => {
      calls.deleteMessage += 1;
      if (options.deleteMessage) return options.deleteMessage(...args);
    },
    prepareResendFromMessage: async (...args) => {
      calls.prepareResend += 1;
      if (options.prepareResendFromMessage) return options.prepareResendFromMessage(...args);
      return { text: "hello" };
    },
    setModel: async () => {
      calls.setModel += 1;
      if (options.modelError) throw new Error(options.modelError);
    },
    setThinking: async () => {
      calls.setThinking += 1;
      if (options.thinkingError) throw new Error(options.thinkingError);
      return options.thinkingState ?? options.runtimeState ?? { isStreaming: false };
    },
    publishRuntimeState: async () => {
      calls.publishRuntimeState += 1;
    },
    isMessageCacheStale: (agentId) => {
      if (options.isMessageCacheStale) return options.isMessageCacheStale(agentId);
      return false;
    },
	refreshSessionIdentity: async (agentId) => {
	  calls.refreshSessionIdentity += 1;
	  const tab = tabs.find((candidate) => candidate.id === agentId);
	  if (!tab) throw new Error("Agent not found");
	  if (options.refreshedSessionPath) {
		tab.sessionPath = options.refreshedSessionPath;
		tab.sessionId = options.refreshedPiSessionId ?? tab.sessionId;
	  }
	  return tab;
	},
    sendUIResponse: async () => {
      calls.uiResponse += 1;
    },
    notifyAskPending: () => {
      calls.askNotify += 1;
    },
  };
  const sender = async (input) => {
    calls.send += 1;
    if (options.sender) return options.sender(input);
    return options.sendResult ?? { accepted: true };
  };
  return { entry, calls, tabs, catalog, agents, sender };
}

function prompt(overrides = {}) {
  return {
    sessionId: "session-1",
    requestId: "request-1",
    message: "hello",
    ...overrides,
  };
}

test("rejects an empty prompt before activating a runtime", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness();
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt({ message: "   " }));
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "rejected");
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.send, 0);
});

test("session security override key = catalog session id, distinct from sessionPath", async () => {
	// 回归：UI 保存安全等级覆盖用 SessionRecord.id（UUID），主进程必须注入同一个 key
	// 给 PIDECK_SESSION_ID，否则安全门扩展在 sessionLevels 里永远查不到覆盖，回落全局默认。
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const sessionId = "e5a4ef67-2c16-4ddc-ac03-d2e105182645";
	const filePath = "C:\\Users\\14012\\.pi\\agent\\sessions\\2026-08-11T13-33-50-880Z_019ff107-89a0-7947-9001-c3fc25237198.jsonl";
	const harness = createHarness({ entry: { id: sessionId, filePath } });
	const coordinator = new SessionRuntimeCoordinator(
		harness.catalog,
		harness.agents,
		harness.sender,
	);

	const result = await coordinator.activateRuntime(sessionId);

	assert.equal(result.ok, true);
	assert.equal(harness.calls.create, 1);
	const createInput = harness.calls.createInputs[0];
	// deckSessionId 必须等于 catalog 会话身份（UI 保存覆盖用的 key），而非文件路径。
	assert.equal(createInput.deckSessionId, sessionId);
	assert.equal(createInput.sessionPath, filePath);
	assert.notEqual(createInput.deckSessionId, createInput.sessionPath);
});

test("explicit activation creates a runtime that is bound to the requested Session", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness();
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );

  const result = await coordinator.activateRuntime("session-1");

  assert.equal(result.ok, true);
  assert.equal(result.value.sessionId, "session-1");
  assert.equal(result.value.agentId, "agent-1");
  assert.equal(result.value.runtimeGeneration, 1);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.send, 0);
});

test("reports a draft activation before its runtime binding completes", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({ createDelay: 20 });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );

  const activation = coordinator.activateRuntime("session-1");
  assert.equal(coordinator.isActivating("session-1"), true);
  await activation;
  assert.equal(coordinator.isActivating("session-1"), false);
});

test("deduplicates concurrent retries by session ID and request ID", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({ createDelay: 20 });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const [first, second] = await Promise.all([
    coordinator.send(prompt()),
    coordinator.send(prompt()),
  ]);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(first.agentId, "agent-1");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.send, 1);
  assert.equal(harness.calls.attach, 2);
});

test("serializes activation but delivers distinct requests once each", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    createDelay: 20,
    entry: {
      model: { provider: "openai", modelId: "gpt-test" },
      thinkingLevel: "high",
    },
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const [first, second] = await Promise.all([
    coordinator.send(prompt({ requestId: "request-1" })),
    coordinator.send(prompt({ requestId: "request-2" })),
  ]);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.setModel, 1);
  assert.equal(harness.calls.setThinking, 1);
  assert.equal(harness.calls.send, 2);
});

test("attaches a delayed session identity after the first accepted prompt", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const sessionPath = "C:/sessions/rust-delayed.jsonl";
	const harness = createHarness({
		createdTab: {
			id: "agent-rust",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Chat agent",
			status: "idle",
			sessionId: "pi-rust-session",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		refreshedSessionPath: sessionPath,
	});
	const coordinator = new SessionRuntimeCoordinator(
		harness.catalog,
		harness.agents,
		harness.sender,
	);

	const result = await coordinator.send(prompt());
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(result.accepted, true);
	assert.equal(harness.calls.refreshSessionIdentity, 1);
	assert.equal(harness.calls.attach, 1);
	assert.equal(harness.entry.filePath, sessionPath);
});

test("dispatch lease blocks restart, direct bind, and catalog scan until send settles", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const started = deferred();
  const release = deferred();
  const harness = createHarness({
    entry: { status: "active", filePath: "C:/sessions/session-1.jsonl" },
    tabs: [{
      id: "agent-1",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1",
      status: "idle",
      sessionPath: "C:/sessions/session-1.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 1,
    }, {
      id: "agent-2",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1 duplicate",
      status: "idle",
      sessionPath: "C:/sessions/session-1.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 2,
    }],
    sender: async () => {
      started.resolve();
      await release.promise;
      return { accepted: true };
    },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  coordinator.bindExistingAgent("session-1", "agent-1");

  const sending = coordinator.send(prompt());
  await started.promise;
  assert.throws(
    () => coordinator.bindExistingAgent("session-1", "agent-2"),
    /prompt dispatch is in progress/,
  );
  await assert.rejects(
    coordinator.restartSession("session-1", "agent-1"),
    /prompt dispatch is in progress/,
  );
  assert.equal(coordinator.attachCatalogRuntimes([{
    ...catalogEntry({ status: "active", filePath: "C:/sessions/session-1.jsonl" }),
    preview: "",
    messageCount: 0,
  }]).length, 0);
  assert.equal(harness.calls.restart, 0);

  release.resolve();
  const result = await sending;
  assert.equal(result.accepted, true);
  const restarted = await coordinator.restartSession("session-1", "agent-1");
  assert.equal(restarted.id, "agent-restarted");
  assert.equal(harness.calls.restart, 1);
});

test("dispatch lease is released when sender throws", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const started = deferred();
  const release = deferred();
  const harness = createHarness({
    sender: async () => {
      started.resolve();
      await release.promise;
      throw new Error("transport uncertain");
    },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const sending = coordinator.send(prompt());
  await started.promise;
  assert.throws(
    () => coordinator.bindExistingAgent("session-1", "agent-1"),
    /prompt dispatch is in progress/,
  );
  release.resolve();
  const result = await sending;
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "unknown");
  assert.equal(result.agentId, "agent-1");
  assert.doesNotThrow(() => coordinator.bindExistingAgent("session-1", "agent-1"));
});

test("stale send result fails closed without exposing a runtime handle", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const started = deferred();
  const release = deferred();
  const harness = createHarness({
    sender: async () => {
      started.resolve();
      await release.promise;
      return { accepted: true };
    },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const sending = coordinator.send(prompt());
  await started.promise;

  coordinator.agentIdBySession.set("session-1", "agent-stale");
  coordinator.sessionIdByAgent.delete("agent-1");
  coordinator.generationBySession.set("session-1", 2);
  release.resolve();

  const result = await sending;
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "unknown");
  assert.equal(result.agentId, undefined);
  assert.equal(result.runtimeGeneration, undefined);
  assert.equal(result.sessionPath, undefined);
  coordinator.agentIdBySession.delete("session-1");
  assert.doesNotThrow(() => coordinator.bindExistingAgent("session-1", "agent-1"));
});

test("reuses an already-running historical session by canonical path", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: {
      status: "active",
      filePath: "C:\\Sessions\\History.jsonl",
      model: { provider: "anthropic", modelId: "claude-test" },
    },
    tabs: [{
      id: "agent-history",
      projectId: "project-1",
      cwd: "C:/project",
      title: "History",
      status: "idle",
      sessionId: "pi-history",
      sessionPath: "c:/sessions/history.jsonl",
      createdAt: 1,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt());
  assert.equal(result.accepted, true);
  assert.equal(result.agentId, "agent-history");
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.setModel, 1);
  assert.equal(harness.calls.send, 1);
});

test("keeps a draft unbound when Agent startup fails", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    getMessages: () => [{
      id: "startup-error",
      agentId: "agent-error",
      role: "error",
      text: "Agent 运行时发生错误。",
      meta: { debugDetails: "pi --mode rpc failed: executable not found" },
      timestamp: 1,
    }],
    createdTab: {
      id: "agent-error",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1",
      status: "error",
      createdAt: 1,
    },
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt());
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "rejected");
  assert.match(result.error, /pi --mode rpc failed: executable not found/);
  assert.equal(harness.entry.status, "draft");
  assert.equal(harness.calls.attach, 0);
  assert.equal(harness.calls.send, 0);
  assert.equal(harness.calls.stop, 1);
});

test("moves the Session binding when a runtime is restarted", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-new", status: "idle", createdAt: 2 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  coordinator.bindExistingAgent("session-1", "agent-old");
  coordinator.bindExistingAgent("session-1", "agent-new");
  assert.equal(coordinator.getSessionId("agent-old"), undefined);
  assert.equal(coordinator.getSessionId("agent-new"), "session-1");
  assert.equal(coordinator.getAgentId("session-1"), "agent-new");
});

test("restart reapplies catalog preferences before binding a new generation", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: {
      status: "active",
      filePath: "C:/sessions/session-1.jsonl",
      model: { provider: "openai", modelId: "gpt-test" },
      thinkingLevel: "high",
    },
    tabs: [{
      id: "agent-old",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1",
      status: "idle",
      sessionPath: "C:/sessions/session-1.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 1,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const firstGeneration = coordinator.bindExistingAgent("session-1", "agent-old");
  const restarted = await coordinator.restartSession("session-1", "agent-old");

  assert.equal(firstGeneration, 1);
  assert.equal(restarted.id, "agent-restarted");
  assert.equal(restarted.runtimeGeneration, 2);
  assert.equal(harness.calls.restart, 1);
  assert.equal(harness.calls.setModel, 1);
  assert.equal(harness.calls.setThinking, 1);
  assert.equal(harness.calls.attach, 1);
  assert.equal(harness.calls.publishRuntimeState, 1);
  assert.equal(coordinator.getSessionId("agent-old"), undefined);
  assert.deepEqual(
    { ...coordinator.getRuntimeBinding("agent-restarted") },
    { sessionId: "session-1", runtimeGeneration: 2 },
  );
});

test("lazy activation publishes runtime state after binding", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: {
      model: { provider: "openai", modelId: "gpt-test" },
      thinkingLevel: "high",
    },
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt());
  assert.equal(result.accepted, true);
  // 懒启动链路：create → waitUntilReady → applyPreferences(setModel/setThinking) →
  // bind → publishRuntimeState。推送必须发生在 bind 之后，否则 emitSessionRuntimeEvent
  // 因无 binding 直接丢弃，渲染层底栏永远看不到应用后的真实模型。
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.setModel, 1);
  assert.equal(harness.calls.setThinking, 1);
  // attach 有两次（activate 内 + dispatch 成功后），这里只断言本测试关注的行为
  assert.equal(harness.calls.publishRuntimeState, 1);
});

test("does not send or bind a new runtime when model setup fails", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { model: { provider: "bad", modelId: "missing" } },
    modelError: "model unavailable",
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt());
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "rejected");
  assert.match(result.error, /model unavailable/);
  assert.equal(harness.entry.status, "draft");
  assert.equal(harness.calls.attach, 0);
  assert.equal(harness.calls.send, 0);
  assert.equal(harness.calls.stop, 1);
});

test("attaches catalog runtimes by full origin identity", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{
      id: "agent-existing",
      projectId: "project-1",
      cwd: "/workspace",
      title: "Existing",
      status: "idle",
      sessionPath: "/home/dev/session.jsonl",
      sessionEnvironment: "wsl",
      sessionSource: "pi",
      wslDistro: "Ubuntu",
      wslUser: "dev",
      createdAt: 1,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const bindings = coordinator.attachCatalogRuntimes([{
    ...catalogEntry({
      environment: "wsl",
      filePath: "/home/dev/session.jsonl",
      wslDistro: "Ubuntu",
      wslUser: "dev",
      status: "active",
    }),
    preview: "",
    messageCount: 0,
  }]);

  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].agentId, "agent-existing");
  assert.deepEqual(
    { ...coordinator.getRuntimeBinding("agent-existing") },
    { sessionId: "session-1", runtimeGeneration: 1 },
  );
});

test("Session UI response requires the current binding, generation, and pending request", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  coordinator.observeRuntimeEvent({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "request-ui",
      method: "confirm",
      title: "Continue?",
    },
  });
  const pending = coordinator.listPendingUiRequests("session-1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, "Continue?");
  assert.equal(pending[0].method, "confirm");

  await assert.rejects(
    coordinator.respondToUi({
      sessionId: "session-1",
      requestId: "request-ui",
      agentId: "agent-a",
      runtimeGeneration: generation - 1,
      response: { confirmed: true },
    }),
    /runtime binding changed/i,
  );
  await coordinator.respondToUi({
    sessionId: "session-1",
    requestId: "request-ui",
    agentId: "agent-a",
    runtimeGeneration: generation,
    response: { confirmed: true },
  });
  await assert.rejects(
    coordinator.respondToUi({
      sessionId: "session-1",
      requestId: "request-ui",
      agentId: "agent-a",
      runtimeGeneration: generation,
      response: { confirmed: true },
    }),
    /not pending/i,
  );
  assert.equal(harness.calls.uiResponse, 1);
});

test("batch Ask Question is accepted by the Session UI response gate", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  coordinator.observeRuntimeEvent({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "batch-ui",
      method: "batch_ask",
      batchQuestions: [{ id: "runtime", type: "select", question: "Runtime?" }],
    },
  });

  await coordinator.respondToUi({
    sessionId: "session-1",
    requestId: "batch-ui",
    agentId: "agent-a",
    runtimeGeneration: generation,
    response: { value: JSON.stringify({ answers: [{ id: "runtime", value: "node" }] }) },
  });

	assert.equal(harness.calls.uiResponse, 1);
});

test("batch Ask Question sanitizes malformed questions in the pending snapshot", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  coordinator.observeRuntimeEvent({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "batch-sanitize",
      method: "batch_ask",
      batchQuestions: [
        { id: "good", type: "select", question: "Runtime?", options: ["node", null, { label: "deno" }, 42] },
        { id: "no-type", question: "No type?" },
        { id: "   ", type: "input", question: "Whitespace id?" },
        "not-a-record",
        { id: "editor", type: "editor", question: "Paste?", prefill: "hello", allowOther: true },
      ],
    },
  });

  const pending = coordinator.listPendingUiRequests("session-1");
  assert.equal(pending.length, 1);
  const questions = pending[0].batchQuestions;
  // 坏条目被丢弃（无 type / 空 id / 非 record），好条目原样保留。
  assert.equal(questions.map((q) => q.id).join("|"), "good|editor");
  // 选项里的 null / 数字被过滤，字符串与对象选项保留（渲染层读 label 不炸）。
  assert.equal(
    JSON.stringify(questions[0].options),
    JSON.stringify(["node", { label: "deno" }]),
  );
  assert.equal(questions[1].prefill, "hello");
  assert.equal(questions[1].allowOther, true);

  // 全部题目都坏时 batchQuestions 整体省略（overlay 回退到 title 渲染）。
  coordinator.observeRuntimeEvent({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "batch-all-bad",
      method: "batch_ask",
      batchQuestions: [null, "text", { id: "x" }],
    },
  });
  const after = coordinator.listPendingUiRequests("session-1");
  const allBad = after.find((item) => item.requestId === "batch-all-bad");
  assert.ok(allBad);
  assert.equal(allBad.batchQuestions, undefined);
});

test("Session UI response is rejected after the closed runtime is unbound", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  coordinator.observeRuntimeEvent({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "request-ui",
      method: "confirm",
      title: "Continue?",
    },
  });

  coordinator.unbindAgent("agent-a");

  await assert.rejects(
    coordinator.respondToUi({
      sessionId: "session-1",
      requestId: "request-ui",
      agentId: "agent-a",
      runtimeGeneration: generation,
      response: { confirmed: true },
    }),
    /runtime binding changed/i,
  );
  assert.equal(harness.calls.uiResponse, 0);
});

test("session runtime inventory and target expose the stable binding triple", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{
      id: "agent-a",
      projectId: "project-1",
      cwd: "C:/project",
      status: "idle",
      sessionPath: "C:/sessions/session-1.jsonl",
      createdAt: 10,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  assert.deepEqual(JSON.parse(JSON.stringify(coordinator.getTarget("session-1"))), {
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(coordinator.listRuntimes())), [{
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    projectId: "project-1",
    cwd: "C:/project",
    status: "idle",
    sessionPath: "C:/sessions/session-1.jsonl",
    createdAt: 10,
  }]);
});

test("anonymous runtime binds an existing --no-session process without attaching a file", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { noSession: true, status: "active" },
    tabs: [{
      id: "anonymous-agent",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Anonymous Chat",
      status: "idle",
      noSession: true,
      createdAt: 1,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtime = coordinator.bindAnonymousRuntime("session-1", "anonymous-agent");
  assert.equal(runtime.noSession, true);
  assert.equal(runtime.sessionPath, undefined);

  const sent = await coordinator.send(prompt());
  assert.equal(sent.accepted, true);
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.attach, 0);

  const restarted = await coordinator.restartRuntime(runtime);
  assert.equal(restarted.ok, true);
  assert.equal(restarted.value.runtime.noSession, true);
  assert.equal(harness.calls.attach, 0);
});

test("stale generation is rejected before a runtime command reaches AgentManager", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  const result = await coordinator.abortRuntime({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation - 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SESSION_RUNTIME_CHANGED");
  assert.equal(harness.calls.abort, 0);
});

test("targeted runtime commands return the validated target and command value", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    runtimeState: { isStreaming: false, modelId: "model-a" },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");
  const target = { sessionId: "session-1", agentId: "agent-a", runtimeGeneration };
  const [state, commands, compact, edited, deleted, resend, exported, aborted] = await Promise.all([
    coordinator.getRuntimeState(target),
    coordinator.listRuntimeCommands(target),
    coordinator.compactRuntime(target, "compact now"),
    coordinator.editRuntimeMessage(target, "message-1", "updated"),
    coordinator.deleteRuntimeMessage(target, "message-2"),
    coordinator.prepareRuntimeResend(target, "message-3"),
    coordinator.exportRuntimeHtml(target),
    coordinator.abortRuntime(target),
  ]);
  for (const result of [state, commands, compact, edited, deleted, resend, exported, aborted]) {
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.value.target)), target);
  }
  assert.equal(harness.calls.runtimeState, 1);
  assert.equal(harness.calls.commands, 1);
  assert.equal(harness.calls.compact, 1);
  assert.equal(harness.calls.editMessage, 1);
  assert.equal(harness.calls.deleteMessage, 1);
  assert.equal(harness.calls.prepareResend, 1);
  assert.equal(harness.calls.exportHtml, 1);
  assert.equal(harness.calls.abort, 1);
});

test("runtime message snapshots retain the validated Session target", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", projectId: "project-1", cwd: "C:/project", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");

  assert.deepEqual(JSON.parse(JSON.stringify(coordinator.getRuntimeMessages("session-1"))), {
    target: { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    value: [{ id: "message-1", role: "assistant", text: "agent-a", timestamp: 1 }],
  });
  assert.equal(harness.calls.messages, 1);
});

test("runtime message snapshots fail closed when the runtime is replaced during the read", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  let coordinator;
  const harness = createHarness({
    tabs: [
      { id: "agent-a", projectId: "project-1", cwd: "C:/project", status: "idle", createdAt: 1 },
      { id: "agent-b", projectId: "project-1", cwd: "C:/project", status: "idle", createdAt: 2 },
    ],
    getMessages: (agentId) => {
      assert.equal(agentId, "agent-a");
      coordinator.bindExistingAgent("session-1", "agent-b");
      return [{ id: "message-a", role: "assistant", text: "stale", timestamp: 1 }];
    },
  });
  coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  coordinator.bindExistingAgent("session-1", "agent-a");

  assert.equal(coordinator.getRuntimeMessages("session-1"), undefined);
  assert.equal(coordinator.getTarget("session-1").agentId, "agent-b");
});

test("runtime message snapshots return undefined when message cache is marked stale", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  let isStale = true;
  const harness = createHarness({
    tabs: [{ id: "agent-a", projectId: "project-1", cwd: "C:/project", status: "idle", createdAt: 1 }],
    isMessageCacheStale: (agentId) => {
      assert.equal(agentId, "agent-a");
      return isStale;
    },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");

  // While stale, getRuntimeMessages returns undefined (not { value: [] })
  assert.equal(coordinator.getRuntimeMessages("session-1"), undefined);

  // Once not stale, getRuntimeMessages returns the snapshot
  isStale = false;
  assert.deepEqual(JSON.parse(JSON.stringify(coordinator.getRuntimeMessages("session-1"))), {
    target: { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    value: [{ id: "message-1", role: "assistant", text: "agent-a", timestamp: 1 }],
  });
});

test("runtime thinking persists the level actually accepted by Pi", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    thinkingState: { isStreaming: false, thinkingLevel: "high" },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");

  const result = await coordinator.setRuntimeThinking(
    { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    "max",
  );

  assert.equal(result.ok, true);
  assert.equal(result.value.value.thinkingLevel, "high");
  assert.equal(harness.entry.thinkingLevel, "high");
  assert.equal(harness.calls.setThinking, 1);
  assert.equal(harness.calls.update, 1);
});

test("runtime thinking failure does not persist an unsupported requested level", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { thinkingLevel: "medium" },
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    thinkingError: "thinking apply failed",
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");

  const result = await coordinator.setRuntimeThinking(
    { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    "max",
  );

  assert.equal(result.ok, false);
  assert.equal(harness.entry.thinkingLevel, "medium");
  assert.equal(harness.calls.update, 0);
});

test("runtime model preference is not persisted when AgentManager fails", async () => {
  // 先写 catalog 再调 pi：用户取消「重启生效」后，下次启动仍会套上未确认模型。
  // 失败路径不得改会话记录；needsRestart 由渲染层在用户确认后再 updateRecord。
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    modelError: "model apply failed",
  });
  const previousModel = harness.entry.model ? { ...harness.entry.model } : undefined;
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");
  const result = await coordinator.setRuntimeModel(
    { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    "openai",
    "gpt-test",
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SESSION_COMMAND_FAILED");
  assert.deepEqual(harness.entry.model, previousModel);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.setModel, 1);
});

test("stop invalidates the target and restart replaces it with a higher generation", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const baseTab = {
    id: "agent-a",
    projectId: "project-1",
    cwd: "C:/project",
    title: "Session",
    status: "idle",
    sessionPath: "C:/sessions/session-1.jsonl",
    createdAt: 1,
  };

  const stopHarness = createHarness({ tabs: [{ ...baseTab }] });
  const stopCoordinator = new SessionRuntimeCoordinator(
    stopHarness.catalog,
    stopHarness.agents,
    stopHarness.sender,
  );
  const stopGeneration = stopCoordinator.bindExistingAgent("session-1", "agent-a");
  const stopped = await stopCoordinator.stopRuntime({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: stopGeneration,
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopCoordinator.getTarget("session-1"), undefined);

  const restartHarness = createHarness({ tabs: [{ ...baseTab }] });
  const restartCoordinator = new SessionRuntimeCoordinator(
    restartHarness.catalog,
    restartHarness.agents,
    restartHarness.sender,
  );
  const restartGeneration = restartCoordinator.bindExistingAgent("session-1", "agent-a");
  const restarted = await restartCoordinator.restartRuntime({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: restartGeneration,
  });
  assert.equal(restarted.ok, true);
  assert.equal(restarted.value.previousTarget.runtimeGeneration, restartGeneration);
  assert.equal(restarted.value.runtime.agentId, "agent-restarted");
  assert.equal(restarted.value.runtime.runtimeGeneration > restartGeneration, true);
  assert.equal(restarted.value.session.id, "session-1");
});

test("commandFailure classifies message-not-found separately from session-not-found", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness();
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  // 编辑/删除/重发缓存与文件都未命中的错误 → MESSAGE_NOT_FOUND（不再误报「会话已不存在」）
  const messageMiss = coordinator.commandFailure(new Error("Message not found"));
  assert.equal(messageMiss.ok, false);
  assert.equal(messageMiss.error.code, "MESSAGE_NOT_FOUND");

  // 活跃分支未命中消息（"Message was not found on the active session branch"）→ MESSAGE_NOT_FOUND
  const branchMiss = coordinator.commandFailure(new Error("Message was not found on the active session branch"));
  assert.equal(branchMiss.ok, false);
  assert.equal(branchMiss.error.code, "MESSAGE_NOT_FOUND");

  // 结构化 code：SESSION_ENTRY_NOT_FOUND → MESSAGE_NOT_FOUND
  const entryNotFound = coordinator.commandFailure(Object.assign(new Error("entry missing"), { code: "SESSION_ENTRY_NOT_FOUND" }));
  assert.equal(entryNotFound.ok, false);
  assert.equal(entryNotFound.error.code, "MESSAGE_NOT_FOUND");

  // 结构化 code：SESSION_ENTRY_AMBIGUOUS → MESSAGE_NOT_FOUND（绝不能是 SESSION_NOT_FOUND）
  const entryAmbiguous = coordinator.commandFailure(Object.assign(new Error("multiple entries match"), { code: "SESSION_ENTRY_AMBIGUOUS" }));
  assert.equal(entryAmbiguous.ok, false);
  assert.equal(entryAmbiguous.error.code, "MESSAGE_NOT_FOUND");

  // 回归：真正的会话不存在仍归 SESSION_NOT_FOUND
  const sessionMiss = coordinator.commandFailure(new Error("Session not found: session-1"));
  assert.equal(sessionMiss.ok, false);
  assert.equal(sessionMiss.error.code, "SESSION_NOT_FOUND");
  // 其他 not found 前缀（agent/项目）不受影响
  const agentMiss = coordinator.commandFailure(new Error("Agent not found: agent-1"));
  assert.equal(agentMiss.error.code, "SESSION_NOT_FOUND");
});

test("commandFailure classifies model-not-found as SESSION_MODEL_NOT_FOUND (not session gone)", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness();
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  // set_model 报 "Model not found: provider/model"（本地 models.json 也没有该模型，
  // 如手误/解析错位产生的假模型）→ 模型不存在，绝不误报「会话已不存在」。
  const modelMiss = coordinator.commandFailure(
    new Error("Model not found: grok.weishiair.de/copy"),
  );
  assert.equal(modelMiss.ok, false);
  assert.equal(modelMiss.error.code, "SESSION_MODEL_NOT_FOUND");
  // {model} 参数提取：i18n 文案「模型未找到：{model}」有值
  assert.equal(modelMiss.error.params?.model, "grok.weishiair.de/copy");
  // 注意：vm 沙箱里主 realm 的 Error 不满足 instanceof，needsRestart 分支无法行为级验证，
  // 用源码断言确认该分支同样提取 model 参数（本地有模型时引导重启而非误报会话不存在）
  const coordinatorSource = readFileSync(
    "src/main/sessions/SessionRuntimeCoordinator.ts",
    "utf8",
  );
  assert.match(
    coordinatorSource,
    /needsRestart: true,[\s\S]*?params: \{ model: this\.extractModelFromNotFound\(error\.message\) \?\? error\.message \}/,
  );
});

test("SessionCommandIpcError maps MESSAGE_NOT_FOUND to the dedicated copy key", () => {
  const { SessionCommandIpcError } = compileModule(
    "src/main/sessions/SessionCommandIpcError.ts",
  );
  const translate = (key) => key;
  const error = new SessionCommandIpcError(
    { code: "MESSAGE_NOT_FOUND", debugDetails: "Message not found" },
    translate,
  );
  assert.equal(error.code, "MESSAGE_NOT_FOUND");
  assert.equal(error.message, "sessionCommand.messageNotFound");
  // 回归：SESSION_NOT_FOUND 仍映射到会话文案 key
  const sessionError = new SessionCommandIpcError(
    { code: "SESSION_NOT_FOUND", debugDetails: "Session not found" },
    translate,
  );
  assert.equal(sessionError.message, "sessionCommand.sessionNotFound");
});

test("history mutations for the same session are serialized: delete A and delete B execute sequentially", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const baseTab = {
    id: "agent-a",
    projectId: "project-1",
    cwd: "C:/project",
    title: "Session",
    status: "idle",
    sessionPath: "C:/sessions/session-1.jsonl",
    createdAt: 1,
  };

  const timeline = [];
  const deleteADeferred = deferred();
  const deleteBDeferred = deferred();

  const harness = createHarness({
    tabs: [{ ...baseTab }],
    deleteMessage: async (_agentId, messageId) => {
      timeline.push(`start:${messageId}`);
      if (messageId === "msg-a") {
        await deleteADeferred.promise;
      } else if (messageId === "msg-b") {
        await deleteBDeferred.promise;
      }
      timeline.push(`end:${messageId}`);
    },
  });

  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");
  const target = { sessionId: "session-1", agentId: "agent-a", runtimeGeneration };

  const promiseA = coordinator.deleteRuntimeMessage(target, "msg-a");
  const promiseB = coordinator.deleteRuntimeMessage(target, "msg-b");

  // Let microtasks tick
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Only msg-a should have started; msg-b should be waiting
  assert.deepEqual(timeline, ["start:msg-a"]);

  // Resolve msg-a
  deleteADeferred.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Now msg-a should have ended, and msg-b should have started
  assert.deepEqual(timeline, ["start:msg-a", "end:msg-a", "start:msg-b"]);

  // Resolve msg-b
  deleteBDeferred.resolve();
  const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

  assert.deepEqual(timeline, ["start:msg-a", "end:msg-a", "start:msg-b", "end:msg-b"]);
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
});

test("history mutations for the same session serialize delete + edit and edit + delete", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const baseTab = {
    id: "agent-a",
    projectId: "project-1",
    cwd: "C:/project",
    title: "Session",
    status: "idle",
    sessionPath: "C:/sessions/session-1.jsonl",
    createdAt: 1,
  };

  const timeline = [];
  const deferred1 = deferred();
  const deferred2 = deferred();

  const harness = createHarness({
    tabs: [{ ...baseTab }],
    deleteMessage: async (_agentId, messageId) => {
      timeline.push(`start:delete:${messageId}`);
      await deferred1.promise;
      timeline.push(`end:delete:${messageId}`);
    },
    editMessage: async (_agentId, messageId, newText) => {
      timeline.push(`start:edit:${messageId}:${newText}`);
      await deferred2.promise;
      timeline.push(`end:edit:${messageId}:${newText}`);
    },
  });

  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");
  const target = { sessionId: "session-1", agentId: "agent-a", runtimeGeneration };

  // 1. delete + edit
  const delPromise = coordinator.deleteRuntimeMessage(target, "msg-1");
  const editPromise = coordinator.editRuntimeMessage(target, "msg-2", "text-2");

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(timeline, ["start:delete:msg-1"]);

  deferred1.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(timeline, ["start:delete:msg-1", "end:delete:msg-1", "start:edit:msg-2:text-2"]);

  deferred2.resolve();
  await Promise.all([delPromise, editPromise]);
  assert.deepEqual(timeline, [
    "start:delete:msg-1",
    "end:delete:msg-1",
    "start:edit:msg-2:text-2",
    "end:edit:msg-2:text-2",
  ]);

  // 2. edit + delete
  const deferred3 = deferred();
  const deferred4 = deferred();
  timeline.length = 0;

  const harnessEditFirst = createHarness({
    tabs: [{ ...baseTab }],
    deleteMessage: async (_agentId, messageId) => {
      timeline.push(`start:delete:${messageId}`);
      await deferred4.promise;
      timeline.push(`end:delete:${messageId}`);
    },
    editMessage: async (_agentId, messageId, newText) => {
      timeline.push(`start:edit:${messageId}:${newText}`);
      await deferred3.promise;
      timeline.push(`end:edit:${messageId}:${newText}`);
    },
  });

  const coordinator2 = new SessionRuntimeCoordinator(
    harnessEditFirst.catalog,
    harnessEditFirst.agents,
    harnessEditFirst.sender,
  );
  const runtimeGeneration2 = coordinator2.bindExistingAgent("session-1", "agent-a");
  const target2 = { sessionId: "session-1", agentId: "agent-a", runtimeGeneration: runtimeGeneration2 };

  const editPromise2 = coordinator2.editRuntimeMessage(target2, "msg-3", "text-3");
  const delPromise2 = coordinator2.deleteRuntimeMessage(target2, "msg-4");

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(timeline, ["start:edit:msg-3:text-3"]);

  deferred3.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(timeline, [
    "start:edit:msg-3:text-3",
    "end:edit:msg-3:text-3",
    "start:delete:msg-4",
  ]);

  deferred4.resolve();
  await Promise.all([editPromise2, delPromise2]);
  assert.deepEqual(timeline, [
    "start:edit:msg-3:text-3",
    "end:edit:msg-3:text-3",
    "start:delete:msg-4",
    "end:delete:msg-4",
  ]);
});

test("history mutations for different sessions execute concurrently", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const baseTab1 = {
    id: "agent-1",
    projectId: "project-1",
    cwd: "C:/project",
    title: "Session 1",
    status: "idle",
    sessionPath: "C:/sessions/session-1.jsonl",
    createdAt: 1,
  };
  const baseTab2 = {
    id: "agent-2",
    projectId: "project-1",
    cwd: "C:/project",
    title: "Session 2",
    status: "idle",
    sessionPath: "C:/sessions/session-2.jsonl",
    createdAt: 2,
  };

  const timeline = [];
  const deferred1 = deferred();
  const deferred2 = deferred();

  const harness = createHarness({
    entries: [
      { id: "session-1", title: "Session 1" },
      { id: "session-2", title: "Session 2" },
    ],
    tabs: [{ ...baseTab1 }, { ...baseTab2 }],
    deleteMessage: async (agentId, messageId) => {
      timeline.push(`start:${agentId}:${messageId}`);
      if (agentId === "agent-1") {
        await deferred1.promise;
      } else {
        await deferred2.promise;
      }
      timeline.push(`end:${agentId}:${messageId}`);
    },
  });

  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const gen1 = coordinator.bindExistingAgent("session-1", "agent-1");
  const gen2 = coordinator.bindExistingAgent("session-2", "agent-2");

  const promise1 = coordinator.deleteRuntimeMessage(
    { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: gen1 },
    "msg-1",
  );
  const promise2 = coordinator.deleteRuntimeMessage(
    { sessionId: "session-2", agentId: "agent-2", runtimeGeneration: gen2 },
    "msg-2",
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  // Both should have started in parallel!
  assert.equal(timeline.includes("start:agent-1:msg-1"), true);
  assert.equal(timeline.includes("start:agent-2:msg-2"), true);
  assert.equal(timeline.length, 2);

  deferred1.resolve();
  deferred2.resolve();
  const [res1, res2] = await Promise.all([promise1, promise2]);
  assert.equal(res1.ok, true);
  assert.equal(res2.ok, true);
});

test("history mutation command fencing: runtime changed during execution returns SESSION_RUNTIME_CHANGED", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const baseTab = {
    id: "agent-a",
    projectId: "project-1",
    cwd: "C:/project",
    title: "Session",
    status: "idle",
    sessionPath: "C:/sessions/session-1.jsonl",
    createdAt: 1,
  };

  const deleteDeferred = deferred();
  let coordinatorRef;

  const harness = createHarness({
    tabs: [{ ...baseTab }],
    deleteMessage: async () => {
      // Mid-command, runtime reaches terminal / unbind
      coordinatorRef.unbindTerminalAgent("agent-a");
      await deleteDeferred.promise;
    },
  });

  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  coordinatorRef = coordinator;
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");
  const target = { sessionId: "session-1", agentId: "agent-a", runtimeGeneration };

  const promise = coordinator.deleteRuntimeMessage(target, "msg-1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  deleteDeferred.resolve();

  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SESSION_RUNTIME_CHANGED");
});
