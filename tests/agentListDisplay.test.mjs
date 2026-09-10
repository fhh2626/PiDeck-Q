import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const identitySandbox = { exports: {} };
	vm.runInNewContext(transpile("src/shared/sessionIdentity.ts"), identitySandbox, {
		filename: "sessionIdentity.ts",
	});
	const sandbox = {
		exports: {},
		require: (specifier) => {
			if (specifier === "../../shared/sessionIdentity") return identitySandbox.exports;
			throw new Error(`Unexpected import: ${specifier}`);
		},
	};
	vm.runInNewContext(transpile("src/renderer/src/agentListDisplay.ts"), sandbox, {
		filename: "agentListDisplay.ts",
	});
	return sandbox.exports;
}

function session(overrides) {
	return {
		id: overrides.filePath,
		filePath: overrides.filePath,
		preview: "",
		updatedAt: overrides.updatedAt ?? 1,
		messageCount: 1,
		source: "codex",
		...overrides,
	};
}

test("matches native Session paths only for runtime/catalog deduplication", () => {
	const { isSameSessionPath } = loadModule();
	const parentPath = "C:\\sessions\\parent.jsonl";
	const childPath = "C:\\sessions\\parent\\run\\session.jsonl";

	assert.equal(
		isSameSessionPath(childPath, childPath.toLowerCase().replaceAll("\\", "/")),
		true,
	);
	assert.equal(isSameSessionPath(parentPath, childPath), false);
	assert.equal(isSameSessionPath(undefined, undefined), false);
});


test("keeps a stable Session row and key when a runtime is attached", () => {
	const { getProjectAgentSessionDisplay, getSessionRowKey } = loadModule();
	const record = session({
		id: "desktop-session-1",
		filePath: "C:/sessions/stable.jsonl",
		source: "pi",
	});
	const before = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [record],
	});
	const after = getProjectAgentSessionDisplay({
		agents: [{
			id: "runtime-1",
			sessionPath: "c:/SESSIONS/STABLE.jsonl",
			sessionEnvironment: "native",
			createdAt: 2,
			status: "idle",
		}],
		sessions: [record],
	});

	assert.equal(before.children[0].type, "session");
	assert.equal(after.children[0].type, "session");
	assert.equal(before.children[0].key, "session:desktop-session-1");
	assert.equal(after.children[0].key, before.children[0].key);
	assert.equal(after.children[0].agent.id, "runtime-1");
	assert.equal(getSessionRowKey(record), "session:desktop-session-1");
});

test("filters runtime rows by their canonical Session origin before falling back to agent source", () => {
	const { filterAgentsForSidebarDisplay } = loadModule();
	const piSession = session({ id: "pi-session", filePath: "C:/sessions/pi.jsonl", source: "pi" });
	const codexSession = session({ id: "codex-session", filePath: "C:/sessions/codex.jsonl", source: "codex" });
	const agents = [
		{ id: "pi-runtime", sessionPath: "c:/SESSIONS/PI.jsonl", sessionEnvironment: "native", sessionSource: "codex", createdAt: 1, status: "running" },
		{ id: "codex-runtime", sessionPath: "c:/SESSIONS/CODEX.jsonl", sessionEnvironment: "native", sessionSource: "pi", createdAt: 2, status: "running" },
		{ id: "unlinked-pi", sessionSource: "pi", createdAt: 3, status: "idle" },
		{ id: "unlinked-codex", sessionSource: "codex", createdAt: 4, status: "idle" },
	];
	const visible = filterAgentsForSidebarDisplay({
		agents,
		allSessions: [piSession, codexSession],
		visibleSessions: [piSession],
		sources: new Set(["pi"]),
	});
	assert.deepEqual(visible.map((agent) => agent.id), ["pi-runtime", "unlinked-pi"]);
});

test("preserves WSL path case while deduplicating native paths", () => {
	const { getProjectAgentSessionDisplay, getAgentForSessionPath } = loadModule();
	const wslDisplay = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [
			session({ filePath: "/home/Dev/session.jsonl", wsl: true }),
			session({ filePath: "/home/dev/session.jsonl", wsl: true }),
		],
	});
	assert.equal(wslDisplay.children.length, 2);

	const agents = [
		{ id: "upper", sessionPath: "/home/Dev/session.jsonl", createdAt: 1 },
		{ id: "lower", sessionPath: "/home/dev/session.jsonl", createdAt: 2 },
	];
	assert.equal(
		getAgentForSessionPath(agents, "/home/Dev/session.jsonl", "wsl")?.id,
		"upper",
	);
	assert.equal(
		getAgentForSessionPath(agents, "/home/Dev/session.jsonl", "native")?.id,
		"lower",
	);
});

test("groups imported Codex subagent sessions under their parent session", () => {
	const { getProjectAgentSessionDisplay } = loadModule();

	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [
			session({
				filePath: "/sessions/codex_parent.jsonl",
				name: "Parent",
				updatedAt: 10,
				codexThreadSource: "user",
			}),
			session({
				filePath: "/sessions/codex_child.jsonl",
				name: "Reviewer",
				updatedAt: 12,
				codexThreadSource: "subagent",
				codexParentThreadId: "parent-thread",
			}),
		].map((item, index) =>
			index === 0 ? { ...item, id: "parent-thread" } : item,
		),
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.name, "Parent");
	assert.equal(display.children[0].codexSubagents.length, 1);
	assert.equal(display.children[0].codexSubagents[0].name, "Reviewer");
});

test("groups Pi child sessions under a parent using normalized paths", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const parentPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent.jsonl";
	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [
			session({ filePath: parentPath, name: "Parent", source: "pi", updatedAt: 10 }),
			session({
				filePath: "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent\\run\\run-0\\session.jsonl",
				name: "Worker",
				source: "pi",
				updatedAt: 12,
				parentSessionPath: "c:/users/dev/.pi/agent/sessions/parent.jsonl",
			}),
		],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].piSubagents.length, 1);
	assert.equal(display.children[0].piSubagents[0].name, "Worker");
});

test("keeps a Rust branched child out of the top-level Agent list", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const parentPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent.jsonl";
	const childPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\rust-child.jsonl";
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "rust-child-runtime",
			projectId: "p1",
			cwd: "C:\\project",
			title: "Rust child",
			status: "running",
			sessionPath: childPath,
			createdAt: 20,
		}],
		sessions: [
			session({ filePath: parentPath, name: "Parent", source: "pi", updatedAt: 10 }),
			session({
				filePath: childPath,
				name: "Rust child",
				source: "pi",
				updatedAt: 12,
				parentSessionPath: parentPath,
			}),
		],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].session.name, "Parent");
	assert.equal(display.children[0].piSubagents.length, 1);
});

test("keeps a started Pi child session nested under its parent without a duplicate top-level agent", () => {
	const { getAgentForSessionPath, getProjectAgentSessionDisplay } = loadModule();
	const parentPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent.jsonl";
	const childPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent\\run\\run-0\\session.jsonl";
	const childSession = session({
		filePath: childPath,
		name: "Worker",
		source: "pi",
		updatedAt: 12,
		parentSessionPath: parentPath,
	});
	const pendingChildAgent = {
		id: "pending-child",
		projectId: "p1",
		cwd: "C:\\project",
		title: "Worker",
		status: "starting",
		sessionPath: childPath.toLowerCase().replaceAll("\\", "/"),
		createdAt: 20,
	};
	const display = getProjectAgentSessionDisplay({
		agents: [pendingChildAgent],
		sessions: [
			session({ filePath: parentPath, name: "Parent", source: "pi", updatedAt: 10 }),
			childSession,
		],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.name, "Parent");
	assert.equal(display.children[0].piSubagents.length, 1);
	assert.equal(getAgentForSessionPath([pendingChildAgent], childSession.filePath).id, "pending-child");
});

test("hides a child runtime marked internal even before its SessionSummary exists", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const childPath = "C:\\sessions\\parent\\run\\run-0\\session.jsonl";
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "agent-child",
			projectId: "p1",
			cwd: "C:\\project",
			title: "subagent-worker-abc-0",
			status: "running",
			sessionPath: childPath,
			isInternalSubagent: true,
			createdAt: 20,
		}],
		sessions: [],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 0);
});

test("isTopLevelListSession hides unresolved internal children", () => {
	const { isTopLevelListSession } = loadModule();
	assert.equal(isTopLevelListSession({
		isInternalSubagent: true,
	}), false);
	assert.equal(isTopLevelListSession({
		parentSessionPath: "C:/sessions/parent.jsonl",
	}), false);
	assert.equal(isTopLevelListSession({
		name: "subagent-worker-manual-0",
	}), true);
});

test("hides an orphan internal Pi child instead of exposing it as a top-level Agent", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const childPath = "/sessions/missing-parent/run/run-0/session.jsonl";
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "agent-child",
			projectId: "p1",
			cwd: "/project",
			title: "Worker",
			status: "running",
			sessionPath: childPath,
			createdAt: 20,
		}],
		sessions: [session({
			filePath: childPath,
			name: "Worker",
			source: "pi",
			updatedAt: 12,
			isInternalSubagent: true,
			parentSessionPath: "/sessions/missing-parent.jsonl",
		})],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 0);
});

test("nests an internal Pi child under its parent without a duplicate top-level Agent", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const parentPath = "C:\\sessions\\parent.jsonl";
	const childPath = "C:\\sessions\\parent\\run\\run-0\\session.jsonl";
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "agent-child",
			projectId: "p1",
			cwd: "C:\\project",
			title: "Worker",
			status: "running",
			sessionPath: childPath,
			createdAt: 20,
		}],
		sessions: [
			session({ filePath: parentPath, name: "Parent", source: "pi", updatedAt: 10 }),
			session({
				filePath: childPath,
				name: "Worker",
				source: "pi",
				updatedAt: 12,
				isInternalSubagent: true,
				parentSessionPath: parentPath,
			}),
		],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.name, "Parent");
	assert.equal(display.children[0].piSubagents.length, 1);
	assert.equal(display.children[0].piSubagents[0].name, "Worker");
});

test("hides an internal Pi child when parentSessionPath is still unresolved", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const childPath = "C:\\sessions\\parent\\run\\run-0\\session.jsonl";
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "agent-child",
			sessionPath: childPath,
			createdAt: 20,
			status: "running",
		}],
		sessions: [session({
			filePath: childPath,
			name: "Worker",
			source: "pi",
			isInternalSubagent: true,
		})],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 0);
});

test("hides a Codex subagent when its parent is temporarily missing", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "codex-child-runtime",
			sessionPath: "/sessions/codex_child.jsonl",
			createdAt: 20,
			status: "running",
		}],
		sessions: [session({
			filePath: "/sessions/codex_child.jsonl",
			name: "Reviewer",
			codexThreadSource: "subagent",
			codexParentThreadId: "missing-parent",
		})],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 0);
});

test("keeps a user session named like a worker in the top-level list", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [session({
			filePath: "C:\\sessions\\subagent-worker-manual-0.jsonl",
			name: "subagent-worker-manual-0",
			source: "pi",
		})],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.name, "subagent-worker-manual-0");
});

test("groups Pi child sessions under an agent whose linked session was filtered out", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const parentPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent.jsonl";
	const agent = {
		id: "agent-1",
		projectId: "p1",
		title: "Parent Agent",
		status: "running",
		sessionPath: parentPath,
		createdAt: 10,
	};
	const display = getProjectAgentSessionDisplay({
		agents: [agent],
		sessions: [
			// 父 sessions 列表不包含父文件（模拟被 Agent 激活后滤掉）
			session({
				filePath: "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent\\run\\run-0\\session.jsonl",
				name: "Worker",
				source: "pi",
				updatedAt: 12,
				parentSessionPath: "c:/users/dev/.pi/agent/sessions/parent.jsonl",
			}),
		],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "agent");
	assert.equal(display.children[0].piSubagents.length, 1);
	assert.equal(display.children[0].piSubagents[0].name, "Worker");
});

test("collectDisplayedSessionIds excludes drafts already shown as agent or session rows", () => {
	const { collectDisplayedSessionIds } = loadModule();
	const sessionRow = {
		type: "session",
		key: "session:history-1",
		session: session({ filePath: "C:/sessions/history.jsonl", id: "history-1" }),
		sortAt: 10,
		codexSubagents: [],
		piSubagents: [],
	};
	const agentRow = {
		type: "agent",
		key: "agent:live-1",
		agent: {
			id: "live-1",
			projectId: "p1",
			cwd: "C:/project",
			title: "PiDeck agent",
			status: "running",
			sessionPath: "C:/sessions/draft.jsonl",
			createdAt: 20,
		},
		sortAt: 20,
		codexSubagents: [],
		piSubagents: [],
	};
	const ids = collectDisplayedSessionIds(
		[sessionRow, agentRow],
		(agent) => (agent.id === "live-1" ? "draft-1" : undefined),
	);
	assert.deepEqual([...ids], ["history-1", "draft-1"]);
});
