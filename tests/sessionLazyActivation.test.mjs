import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Batch 2A: Lazy Session activation invariants.
 *
 * These tests verify that the frozen architecture preserves the rule:
 * "打开/切换 Session 不启动 Agent；首次发送消息才激活 runtime。"
 *
 * They validate behavioral contracts in source files; they do NOT
 * mock Jotai stores or run React. If a test fails, it means the
 * frozen architecture's source code no longer enforces the invariant.
 */

// ── source files ──

const sessionSendSource = readFileSync(
  "src/renderer/src/hooks/useSessionSend.ts",
  "utf8",
);
const sessionActionsSource = readFileSync(
  "src/renderer/src/hooks/useSessionActions.ts",
  "utf8",
);
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

// ── helpers ──

function functionBody(name, source) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} should exist in source`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not parse function body for ${name}`);
}

/**
 * Extract a specific returned function from a hook returned object.
 * Works with patterns like:
 *   return {
 *     openSidebarSession: async (...) => { ... },
 *     ...
 *   }
 *   or
 *   return async function sendSessionPrompt(...) { ... }
 */
function returnedFunctionBody(name, source) {
  // Try async arrow in object:  name: async (...) => { ... }
  const objArrow = new RegExp(
    `\\b${name}\\s*:\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*\\{`,
  );
  const match = source.match(objArrow);
  if (match) {
    const bodyStart = source.indexOf("{", match.index + match[0].length - 1);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(bodyStart + 1, index);
      }
    }
  }
  // Try regular function: return async function name(...) { ... }
  const funcMarker = `return async function ${name}(`;
  const funcStart = source.indexOf(funcMarker);
  if (funcStart !== -1) {
    const bodyStart = source.indexOf("{", funcStart);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(bodyStart + 1, index);
      }
    }
  }
  // Try exported named function: export async function name(...)
  {
    const exportMarker = `export async function ${name}(`;
    const exportStart = source.indexOf(exportMarker);
    if (exportStart !== -1) {
      const bodyStart = source.indexOf("{", exportStart);
      let depth = 0;
      for (let index = bodyStart; index < source.length; index += 1) {
        const char = source[index];
        if (char === "{") depth += 1;
        if (char === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(bodyStart + 1, index);
        }
      }
    }
  }
  // Try named async function: async function name(...)
  {
    const namedMarker = `async function ${name}(`;
    const namedStart = source.indexOf(namedMarker);
    if (namedStart !== -1) {
      const bodyStart = source.indexOf("{", namedStart);
      let depth = 0;
      for (let index = bodyStart; index < source.length; index += 1) {
        const char = source[index];
        if (char === "{") depth += 1;
        if (char === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(bodyStart + 1, index);
        }
      }
    }
  }
  // Try plain named function: function name(...)
  {
    const namedMarker = `function ${name}(`;
    const namedStart = source.indexOf(namedMarker);
    if (namedStart !== -1) {
      const bodyStart = source.indexOf("{", namedStart);
      let depth = 0;
      for (let index = bodyStart; index < source.length; index += 1) {
        const char = source[index];
        if (char === "{") depth += 1;
        if (char === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(bodyStart + 1, index);
        }
      }
    }
  }
  throw new Error(`Could not locate returned function: ${name}`);
}

// ── Tests ──

// ════════════════════════════════════════════════════════════════════
// 1. Lazy Session open: no Agent creation
// ════════════════════════════════════════════════════════════════════

test("openSidebarSession selects a SessionRecord without Agent creation primitives", () => {
  const body = returnedFunctionBody("openSidebarSession", sessionActionsSource);
  assert.match(body, /await refreshProjectSessions\(projectId/);
  assert.match(body, /commitSessionSelection\(projectId, record\.id/);
  assert.doesNotMatch(body, /listCatalog|bindSessionRuntime|createAgent\(/);
});

test("selectSession does not trigger bindSessionRuntime or Agent start", () => {
  const body = returnedFunctionBody("selectSession", sessionActionsSource);
  assert.doesNotMatch(body, /bindSessionRuntime|bindRuntime|createAgent\(|listCatalog/);
});

test("history drawer uses lazy Session open in DrawerSurface", () => {
  const drawerSource = readFileSync(
    "src/renderer/src/components/workspace/DrawerSurface.tsx",
    "utf8",
  );
  assert.match(drawerSource, /onOpenSession=\{/);
});

// ════════════════════════════════════════════════════════════════════
// 2. First send activates runtime
// ════════════════════════════════════════════════════════════════════

test("sendSessionPrompt binds runtime after successful prompt send", () => {
  const body = returnedFunctionBody("sendSessionPrompt", sessionSendSource);
  assert.match(body, /requestId = crypto\.randomUUID\(\)/);
  assert.match(body, /options\.sendPrompt\(\{/);

  // When no runtimeAgentId exists, send state = "activating"
  assert.match(
    body,
    /status:\s*runtimeAgentId\s*\?\s*"sending"\s*:\s*"activating"/,
  );

  // After send, bindRuntime is called with result
  assert.match(body, /bindRuntime\(\{/);
  assert.match(body, /sessionId/);
  assert.match(body, /agentId:\s*result\.agentId/);
  assert.match(body, /runtimeGeneration:\s*result\.runtimeGeneration/);
  assert.match(
    body,
    /result\.accepted\s*\?\s*"running"\s*:\s*undefined/,
  );
});

test("sendSessionPrompt rejects empty and whitespace-only drafts", () => {
  const body = returnedFunctionBody("sendSessionPrompt", sessionSendSource);

  // Empty/whitespace without images must return early before send
  assert.match(body, /if\s*\(!hasComposerSubmission\(message,\s*imageSnapshot\)\)\s*return/);
});

test("hasComposerSubmission correctly rejects empty messages", () => {
  const body = functionBody("hasComposerSubmission", sessionSendSource);
  assert.match(body, /message\.trim\(\)/);
  // Must also consider images
  assert.match(body, /images\?\.length/);
});

test("sendSessionPrompt without runtime binding shows activating send state", () => {
  const body = returnedFunctionBody("sendSessionPrompt", sessionSendSource);

  // Verify the activating/sending branch exists
  assert.match(
    body,
    /status:\s*runtimeAgentId\s*\?\s*"sending"\s*:\s*"activating"/,
  );
  assert.match(body, /requestId/);

  // After accepted result, idle state is restored
  assert.match(body, /"idle"/);
});

// ════════════════════════════════════════════════════════════════════
// 3. Session identity protection during fast switching
// ════════════════════════════════════════════════════════════════════

test("App derives activeAgentId from Session runtime binding atom", () => {
  assert.match(appSource, /activeAgentIdAtom/);
  assert.match(appSource, /const activeAgentId = useAtomValue\(activeAgentIdAtom\)/);
  assert.doesNotMatch(appSource, /setActiveAgentId/);
});

test("Session has no Agent runtime before first send", () => {
  // Verify sessionRuntimeByIdAtom is the only source of truth
  const atomsSource = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
  assert.match(atomsSource, /sessionRuntimeByIdAtom/);

  // The atom's initial state is an empty record (no pre-bound agents)
  assert.match(
    atomsSource,
    /sessionRuntimeByIdAtom\s*=\s*atom.*Record.*\{\}/,
  );
});

test("active Agent identity does not use useState", () => {
  assert.doesNotMatch(
    appSource,
    /useState<[^>]*>\([^)]*\).*activeAgentId/,
  );
});

// ════════════════════════════════════════════════════════════════════
// 4. Deterministic bug parity: TurnRow hook order
// ════════════════════════════════════════════════════════════════════

// TurnRow 是 .tsx，没有 DOM 环境可渲染，只能做静态分析。分析器必须先证明自己真的取到了函数体：
// 组件声明是 `memo(\n function TurnRow(...)` 多行写法，早先按单行串查找得到 -1，函数体被误取成 import 花括号，
// 两条守卫于是恒绿。因此这里用正则定位并断言函数体足够大、hook 足够多，再做顺序检查。
const HOOK_PATTERNS = [
  /\buseState\(/,
  /\buseRef\(/,
  /\buseMemo\(/,
  /\buseCallback\(/,
  /\buseEffect\(/,
  /\buseLayoutEffect\(/,
  /\buseAtomValue\(/,
  /\buseSetAtom\(/,
  /\buseStore\(/,
];

/** 取出 TurnRow 函数体文本（花括号配平）。 */
function extractTurnRowBody(source) {
  const declaration = /function TurnRow\([^)]*\)\s*\{/.exec(source);
  assert.ok(declaration, "TurnRow should exist in turn/TurnRow.tsx");
  const bodyStart = declaration.index + declaration[0].length - 1;
  let depth = 0;
  let end = bodyStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart, end);
}

function analyseTurnRowHooks() {
  const source = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
  const lines = extractTurnRowBody(source).split("\n");
  const hookLines = [];
  let firstEarlyReturnLine = -1;
  lines.forEach((line, index) => {
    if (HOOK_PATTERNS.some((pattern) => pattern.test(line))) hookLines.push(index);
    if (firstEarlyReturnLine === -1 && /\breturn\s+null\b/.test(line)) firstEarlyReturnLine = index;
  });
  return { lines, hookLines, firstEarlyReturnLine };
}

test("the TurnRow analyser really sees the component body", () => {
  const { lines, hookLines, firstEarlyReturnLine } = analyseTurnRowHooks();
  assert.ok(lines.length > 100, `body should be the whole component (got ${lines.length} lines)`);
  assert.ok(hookLines.length >= 8, `body should contain the component's hooks (got ${hookLines.length})`);
  assert.notEqual(firstEarlyReturnLine, -1, "TurnRow has an early `return null` the guard must compare against");
});

test("TurnRow puts all hooks before any early return", () => {
  const { hookLines, firstEarlyReturnLine } = analyseTurnRowHooks();
  const lateHooks = hookLines.filter((line) => line > firstEarlyReturnLine);
  assert.deepEqual(
    lateHooks,
    [],
    `TurnRow has hooks after the early return at body line ${firstEarlyReturnLine}: lines ${lateHooks.join(", ")}. This causes 'Rendered fewer hooks' crash.`,
  );
});

// ════════════════════════════════════════════════════════════════════
// 5. Deterministic bug parity: idle skeleton not shown
// ════════════════════════════════════════════════════════════════════

test("deriveSessionSurfaceRuntime hides loading for idle non-activating Session", () => {
  const controllerSource = readFileSync(
    "src/renderer/src/hooks/useSessionTimelineController.ts",
    "utf8",
  );

  // deriveSessionSurfaceRuntime must exist
  const fnBody = functionBody(
    "deriveSessionSurfaceRuntime",
    controllerSource,
  );

  // isLoading = true only when messageCount===0 AND (loading or activating)
  assert.match(fnBody, /isLoading:\s*messageCount\s*===\s*0\s*&&/);
  assert.match(fnBody, /messageLoadStatus\s*===\s*"loading"/);
  assert.match(fnBody, /activating/);

  // isStarting 与 status==="starting" 同源：activating=true 时 status 恒为 "starting"
  assert.match(fnBody, /isStarting:\s*activating/);
  assert.match(fnBody, /const status = activating \? "starting" : runtimeStatus/);

  // idle with messages: isLoading=false, isStarting=false
  // This naturally fixes the "idle 后仍显示启动骨架" bug from dev f959ae2
});

// ════════════════════════════════════════════════════════════════════
// 6. Project toggle behavior
// ════════════════════════════════════════════════════════════════════

test("ProjectTree selects and toggles a project from its primary row", () => {
  const projectTreeSource = readFileSync(
    "src/renderer/src/components/sidebar/ProjectTree.tsx",
    "utf8",
  );

  // The whole project row is the accordion control. This makes the state
  // discoverable and keeps projects with lazily loaded sessions operable.
  assert.match(projectTreeSource, /onClick=\{\(\) => \{[\s\S]*?props\.controller\.toggleProject\(project\.id\);[\s\S]*?props\.actions\.projects\.select\(project\.id\);[\s\S]*?\}\}/);
  assert.match(projectTreeSource, /onClick=\{\(\) => props\.controller\.toggleProject\(project\.id\)\}/);
});

// ════════════════════════════════════════════════════════════════════
// 7. Routing: no setCurrentSessionId in App
// ════════════════════════════════════════════════════════════════════

test("App never calls setCurrentSessionId directly", () => {
  assert.doesNotMatch(appSource, /setCurrentSessionId\(/);
  assert.match(appSource, /selectSessionCommand\(/);
});
