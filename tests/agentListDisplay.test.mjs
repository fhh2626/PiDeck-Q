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

test("subagent status dot prefers a live runtime and otherwise uses the child agent", () => {
	const { visibleSidebarStatus, sessionStatusDotClass, subagentSidebarStatus } = loadModule();
	assert.equal(visibleSidebarStatus({ runtimeStatus: "running", agentStatus: "idle" }), "running");
	assert.equal(visibleSidebarStatus({ runtimeStatus: "detached", agentStatus: "idle" }), undefined);
	assert.equal(visibleSidebarStatus({ runtimeStatus: "closed", agentStatus: "error" }), undefined);
	assert.equal(visibleSidebarStatus({ agentStatus: "starting" }), "starting");
	assert.equal(visibleSidebarStatus({ runtimeStatus: "detached", agentStatus: "closed" }), undefined);
	assert.equal(sessionStatusDotClass("idle"), "bg-info");
	assert.equal(sessionStatusDotClass("running"), "bg-warning");
	assert.equal(sessionStatusDotClass("error"), "bg-danger");

	const session = {
		id: "child-1",
		filePath: "/home/user/proj/Session.jsonl",
		wsl: true,
	};
	const agents = [
		{
			deckSessionId: "child-1",
			sessionPath: "/home/user/proj/session.jsonl",
			sessionEnvironment: "wsl",
			status: "closed",
			createdAt: 1,
		},
		{
			deckSessionId: "child-1",
			sessionPath: "/home/user/proj/Session.jsonl",
			sessionEnvironment: "wsl",
			status: "running",
			createdAt: 2,
		},
		{
			sessionPath: "/home/user/proj/Session.jsonl",
			sessionEnvironment: "native",
			status: "error",
			createdAt: 3,
		},
	];
	assert.equal(subagentSidebarStatus(session, agents, "detached"), undefined);
	assert.equal(subagentSidebarStatus(session, agents), "running");
	// completed 是短暂保留，不在行上点灯。
	assert.equal(subagentSidebarStatus(session, [], undefined, [
		{ sessionFile: "/home/user/proj/Session.jsonl", status: "completed", updatedAt: 1 },
	]), undefined);
	assert.equal(subagentSidebarStatus(session, [
		{
			deckSessionId: "child-1",
			sessionPath: "/home/user/proj/Session.jsonl",
			sessionEnvironment: "wsl",
			status: "running",
			createdAt: 1,
		},
		{
			deckSessionId: "child-1",
			sessionPath: "/home/user/proj/Session.jsonl",
			sessionEnvironment: "wsl",
			status: "idle",
			createdAt: 5,
		},
	]), "idle");
	assert.equal(subagentSidebarStatus({
		id: "native-child",
		filePath: "C:/sessions/Child.jsonl",
	}, [{
		sessionPath: "C:/sessions/child.jsonl",
		status: "running",
		createdAt: 1,
	}]), undefined);
	assert.equal(subagentSidebarStatus({
		id: "wsl-only",
		filePath: "/home/user/proj/Session.jsonl",
		wsl: true,
	}, [
		{
			sessionPath: "/home/user/proj/Session.jsonl",
			sessionEnvironment: "native",
			status: "error",
			createdAt: 5,
		},
		{
			sessionPath: "/home/user/proj/session.jsonl",
			sessionEnvironment: "wsl",
			status: "idle",
			createdAt: 1,
		},
	]), undefined);

	const tree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
	assert.match(tree, /renderRuntimeStatusDot\(subagentStatus\(session\)\)/);
	assert.match(tree, /subagentSidebarStatus\(/);
});

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

test("subagent status dot falls back to the live subagent run projection", () => {
	const { subagentSidebarStatus, visibleSidebarStatus } = loadModule();
	const childFile = "C:/sessions/Parent/run-1/run-0/session.jsonl";
	const child = session({ filePath: childFile });
	const running = [{ sessionFile: "c:/SESSIONS/parent/run-1/run-0/Session.jsonl", status: "running", updatedAt: 1 }];
	const failed = [{ sessionFile: childFile, status: "error", updatedAt: 1 }];

	// pi 内建子代理没有 PiDeck runtime / Agent：工具 details 投影是唯一状态来源。
	assert.equal(subagentSidebarStatus(child, [], undefined, running), "running");
	assert.equal(subagentSidebarStatus(child, [], "", failed), "error");
	// PiDeck runtime 快照优先：用户手动打开子会话后以 runtime 为准（detached 仍然无点）。
	assert.equal(subagentSidebarStatus(child, [], "idle", running), "idle");
	assert.equal(subagentSidebarStatus(child, [], "detached", running), undefined);
	// 路径不匹配 / 缺省投影都不点亮该行。
	assert.equal(subagentSidebarStatus(child, [], undefined, [
		{ sessionFile: "C:/sessions/other/run-1/run-0/session.jsonl", status: "running", updatedAt: 1 },
	]), undefined);
	assert.equal(subagentSidebarStatus(child, []), undefined);
	// WSL 路径区分大小写，不能把另一个会话误点亮。
	assert.equal(subagentSidebarStatus(
		session({ filePath: "/home/u/S.jsonl", wsl: true }),
		[],
		undefined,
		[{ sessionFile: "/home/u/s.jsonl", status: "running", updatedAt: 1 }],
	), undefined);
	// 同一路径多条时取最新一次观察：子会话被 resume 后旧 error 不能让行一直红着。
	assert.equal(subagentSidebarStatus(child, [], undefined, [
		{ sessionFile: childFile, status: "error", updatedAt: 5 },
		{ sessionFile: childFile, status: "running", updatedAt: 9 },
	]), "running");
	assert.equal(subagentSidebarStatus(child, [], undefined, [
		{ sessionFile: childFile, status: "running", updatedAt: 5 },
		{ sessionFile: childFile, status: "error", updatedAt: 9 },
	]), "error");
	// 子代理投影低于 runtime 快照，但高于匹配 Agent。
	assert.equal(visibleSidebarStatus({ subagentStatus: "error", agentStatus: "idle" }), "error");
	assert.equal(visibleSidebarStatus({ runtimeStatus: "idle", subagentStatus: "error" }), "idle");
});

test("collapsed subagent group reports running before a just-finished child", () => {
	const { subagentGroupActivity } = loadModule();
	const childFile = "C:/sessions/Parent/run-1/run-0/session.jsonl";
	const child = session({ filePath: childFile, isInternalSubagent: true, parentSessionPath: "C:/sessions/Parent.jsonl" });

	// native 路径大小写/分隔符不敏感：与行上状态点共用同一套归一化。
	assert.equal(subagentGroupActivity([child], [
		{ sessionFile: "c:\\sessions\\parent\\run-1\\run-0\\Session.jsonl", status: "running", updatedAt: 5 },
	]), "running");
	// 只有错误不亮折叠灯：错误靠展开后的红灯表达。
	assert.equal(subagentGroupActivity([child], [{ sessionFile: childFile, status: "error", updatedAt: 5 }]), undefined);
	// 刚完成的子代理也算，但文案不能说「运行中」，所以返回 completed 而不是 running。
	assert.equal(subagentGroupActivity([child], [{ sessionFile: childFile, status: "completed", updatedAt: 5 }]), "completed");
	// running 优先于 completed：有一个还在跑就报 running。
	assert.equal(subagentGroupActivity([child, session({ filePath: "C:/sessions/Parent/run-2/run-0/session.jsonl" })], [
		{ sessionFile: childFile, status: "completed", updatedAt: 5 },
		{ sessionFile: "C:/sessions/Parent/run-2/run-0/session.jsonl", status: "running", updatedAt: 6 },
	]), "running");
	// 跑的是别的子会话
	assert.equal(subagentGroupActivity([child], [{ sessionFile: "C:/other/s.jsonl", status: "running", updatedAt: 5 }]), undefined);
	assert.equal(subagentGroupActivity([child], []), undefined);
	assert.equal(subagentGroupActivity([], [{ sessionFile: childFile, status: "running", updatedAt: 5 }]), undefined);
});
