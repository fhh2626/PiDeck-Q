import { canonicalizeSessionPath, getSessionEnvironment } from "../../shared/sessionIdentity";
import type { AgentTab, SessionEnvironment, SessionSummary } from "../../shared/types";

/**
 * 会话/Agent 行的状态点 Tailwind bg 类（跨 Sidebar SessionTree 与会话 Tab 复用）。
 * 用户语义：idle=蓝、starting/运行中=黄、error=红；未启动（无 runtime）不显示点。
 * 该 helper 同时供会话 Tab 与侧栏会话行使用，确保蓝/黄/红状态语义一致。
 */
export function sessionStatusDotClass(status?: string | null): string | undefined {
	// detached 视为未真正运行：不渲染色点，与未启动会话一致
	if (!status || status === "detached") return undefined;
	switch (status) {
		case "error":
			return "bg-danger";
		case "idle":
			return "bg-info";
		// running / starting / pending 均反映“正在工作/等待”，同一黄色点
		case "running":
		case "starting":
		case "pending":
		case "waiting":
			return "bg-warning";
		default:
			return undefined;
	}
}

const DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT = 5;

export type ProjectChildItem =
	| {
			type: "agent";
			key: string;
			agent: AgentTab;
			sortAt: number;
			/** 该 Agent 对应的会话来源（历史会话激活时从 SessionSummary 传递） */
			source?: "pi" | "codex" | "claude" | "opencode";
			/** Codex 导入的子会话 */
			codexSubagents: SessionSummary[];
			/** pi 原生子会话（pi-subagents 等扩展产生的，通过 parentSessionPath 关联） */
			piSubagents: SessionSummary[];
	  }
	| {
			type: "session";
			key: string;
			session: SessionSummary;
			/** Optional runtime decoration; the visible row remains Session-owned. */
			agent?: AgentTab;
			sortAt: number;
			/** Codex 导入的子会话 */
			codexSubagents: SessionSummary[];
			/** pi 原生子会话（pi-subagents 等扩展产生的，通过 parentSessionPath 关联） */
			piSubagents: SessionSummary[];
	  };

export type ProjectAgentSessionDisplay = {
	children: ProjectChildItem[];
	visibleChildren: ProjectChildItem[];
	hiddenChildCount: number;
};

/**
 * 统一列表（Agent/历史会话行）已占用的 catalog Session ID。
 * draft 区块必须排除这些 ID，否则启动后会出现「draft 标题行 + Agent 行」重复入口。
 */
export function collectDisplayedSessionIds(
	visibleChildren: readonly ProjectChildItem[],
	resolveAgentSessionId: (agent: AgentTab) => string | undefined,
): Set<string> {
	const ids = new Set<string>();
	for (const child of visibleChildren) {
		if (child.type === "session") {
			ids.add(child.session.id);
			continue;
		}
		const sessionId = resolveAgentSessionId(child.agent);
		if (sessionId) ids.add(sessionId);
	}
	return ids;
}

// native 路径不区分大小写；WSL 路径保留大小写，并使用环境前缀防止跨来源碰撞。
export function normalizeSessionPathForCompare(
	sessionPath?: string,
	environment: SessionEnvironment = "native",
) {
	return sessionPath ? canonicalizeSessionPath(sessionPath, environment) : undefined;
}

export function isSameSessionPath(
	left?: string,
	right?: string,
	environment: SessionEnvironment = "native",
) {
	const normalizedLeft = normalizeSessionPathForCompare(left, environment);
	const normalizedRight = normalizeSessionPathForCompare(right, environment);
	return Boolean(
		normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
	);
}

function getSessionKey(
	sessionPath?: string,
	environment: SessionEnvironment = "native",
) {
	const normalized = normalizeSessionPathForCompare(sessionPath, environment);
	return normalized ? `${environment}:${normalized}` : undefined;
}

function getSummaryKey(session: SessionSummary) {
	return getSessionKey(session.filePath, getSessionEnvironment(session));
}

function isInternalListChild(session: SessionSummary) {
	return session.isInternalSubagent === true || session.codexThreadSource === "subagent";
}

/**
 * Session rows are owned by the catalog record, never by a transient runtime.
 * Keep this helper at the display boundary so every Sidebar tree uses the
 * durable SessionRecord/SessionSummary identity for its React key.
 */
export function getSessionRowKey(session: Pick<SessionSummary, "id">) {
	return `session:${session.id}`;
}

function findSessionKeyForAgent(
	sessionPath: string | undefined,
	sessionByKey: Map<string, SessionSummary>,
) {
	const wslKey = getSessionKey(sessionPath, "wsl");
	if (wslKey && sessionByKey.has(wslKey)) return wslKey;
	const nativeKey = getSessionKey(sessionPath, "native");
	return nativeKey && sessionByKey.has(nativeKey) ? nativeKey : undefined;
}

function getCodexParentKey(session: SessionSummary) {
	return session.codexSessionId ?? session.id;
}

function getAgentSortAt(agent: AgentTab, sessionByKey: Map<string, SessionSummary>) {
	const sessionKey = findSessionKeyForAgent(agent.sessionPath, sessionByKey);
	// 历史会话激活成 Agent 后仍按原会话更新时间排序；全新 Agent 没有历史文件时按创建时间排到最新。
	return sessionKey ? (sessionByKey.get(sessionKey)?.updatedAt ?? agent.createdAt) : agent.createdAt;
}

function chooseAgentForSession(current: AgentTab, candidate: AgentTab) {
	// 如果异常状态下同一个 sessionPath 已经产生多个 Agent，UI 只保留一个：优先保留更新创建的运行态，避免继续暴露重复入口。
	if (candidate.createdAt !== current.createdAt) {
		return candidate.createdAt > current.createdAt ? candidate : current;
	}
	return candidate.status === "running" ? candidate : current;
}

/** 查找某个历史 Session 当前关联的 Pending/真实 Agent，供侧栏展示 runtime 状态。 */
export function getAgentForSessionPath(
	agents: AgentTab[],
	sessionPath?: string,
	environment: SessionEnvironment = "native",
): AgentTab | undefined {
	const sessionKey = getSessionKey(sessionPath, environment);
	if (!sessionKey) return undefined;
	let matched: AgentTab | undefined;
	for (const agent of agents) {
		if (agent.sessionEnvironment && agent.sessionEnvironment !== environment) continue;
		if (getSessionKey(agent.sessionPath, environment) !== sessionKey) continue;
		matched = matched ? chooseAgentForSession(matched, agent) : agent;
	}
	return matched;
}

/**
 * A source filter applies to the Session origin, not the runtime process. If an
 * Agent has a catalog Session, resolve that relationship with the same canonical
 * environment/path rules as display deduplication. Only unlinked Agents use
 * their own source decoration as the filter fallback.
 */
export function filterAgentsForSidebarDisplay({
	agents,
	allSessions,
	visibleSessions,
	sources,
}: {
	agents: AgentTab[];
	allSessions: SessionSummary[];
	visibleSessions: SessionSummary[];
	sources: ReadonlySet<NonNullable<SessionSummary["source"]>> | null;
}): AgentTab[] {
	if (sources === null) return agents;
	const allSessionsByKey = new Map<string, SessionSummary>();
	for (const session of allSessions) {
		const key = getSummaryKey(session);
		if (key) allSessionsByKey.set(key, session);
	}
	const visibleSessionKeys = new Set(
		visibleSessions.map(getSummaryKey).filter((key): key is string => Boolean(key)),
	);
	return agents.filter((agent) => {
		const environment = agent.sessionEnvironment;
		const explicitSessionKey = environment
			? getSessionKey(agent.sessionPath, environment)
			: undefined;
		const linkedSessionKey = explicitSessionKey && allSessionsByKey.has(explicitSessionKey)
			? explicitSessionKey
			: findSessionKeyForAgent(agent.sessionPath, allSessionsByKey);
		return linkedSessionKey
			? visibleSessionKeys.has(linkedSessionKey)
			: sources.has(agent.sessionSource ?? "pi");
	});
}

export function getProjectAgentSessionDisplay({
	agents,
	sessions,
	visibleChildCount,
}: {
	agents: AgentTab[];
	sessions: SessionSummary[];
	visibleChildCount?: number;
}): ProjectAgentSessionDisplay {
	const sessionByKey = new Map<string, SessionSummary>();
	const unkeyedSessions: SessionSummary[] = [];
	const codexSubagentsByParent = new Map<string, SessionSummary[]>();

	// pi 原生子会话分组：按 parentSessionPath（归一化）关联到父会话
	const piSubagentsByParent = new Map<string, SessionSummary[]>();

	const parentCandidateSessions = sessions.filter(
		(session) => !isInternalListChild(session),
	);
	const parentCodexIds = new Set(
		parentCandidateSessions.map(getCodexParentKey).filter(Boolean),
	);
	const hiddenInternalSessionKeys = new Set<string>();
	for (const session of sessions) {
		// Codex 内部子会话：父节点可见才挂到父下；否则暂时隐藏，不升为顶层。
		if (session.codexThreadSource === "subagent") {
			if (session.codexParentThreadId && parentCodexIds.has(session.codexParentThreadId)) {
				const children = codexSubagentsByParent.get(session.codexParentThreadId) ?? [];
				children.push(session);
				codexSubagentsByParent.set(session.codexParentThreadId, children);
			}
			const sessionKey = getSummaryKey(session);
			if (sessionKey) hiddenInternalSessionKeys.add(sessionKey);
			continue;
		}

		// pi 内部子会话：永远不进顶层 sessionByKey；父路径可解析时才挂到父下。
		// 旧 catalog 可能只有 parentSessionPath、尚未带 isInternalSubagent，同样不得升为顶层。
		if (session.isInternalSubagent || session.parentSessionPath) {
			if (session.parentSessionPath) {
				const parentKey = getSessionKey(
					session.parentSessionPath,
					getSessionEnvironment(session),
				);
				if (parentKey) {
					const children = piSubagentsByParent.get(parentKey) ?? [];
					children.push(session);
					piSubagentsByParent.set(parentKey, children);
				}
			}
			const sessionKey = getSummaryKey(session);
			if (sessionKey) hiddenInternalSessionKeys.add(sessionKey);
			continue;
		}

		const sessionKey = getSummaryKey(session);
		if (sessionKey) sessionByKey.set(sessionKey, session);
		else unkeyedSessions.push(session);
	}

	const agentBySessionKey = new Map<string, AgentTab>();
	const unkeyedAgents: AgentTab[] = [];
	for (const agent of agents) {
		const linkedKey = findSessionKeyForAgent(agent.sessionPath, sessionByKey);
		const nativeKey = getSessionKey(agent.sessionPath, "native");
		const wslKey = getSessionKey(agent.sessionPath, "wsl");
		const hiddenByIdentity = Boolean(
			(nativeKey && hiddenInternalSessionKeys.has(nativeKey)) ||
			(wslKey && hiddenInternalSessionKeys.has(wslKey)),
		);
		if (hiddenByIdentity) continue;
		const sessionKey = linkedKey ?? nativeKey;
		if (!sessionKey) {
			unkeyedAgents.push(agent);
			continue;
		}
		const current = agentBySessionKey.get(sessionKey);
		agentBySessionKey.set(
			sessionKey,
			current ? chooseAgentForSession(current, agent) : agent,
		);
	}

	// 内部子会话启动后也会产生 Agent，但它不得进入顶层列表。
	const nestedAgentSessionKeys = new Set<string>(hiddenInternalSessionKeys);
	for (const subagents of piSubagentsByParent.values()) {
		for (const subagent of subagents) {
			const sessionKey = getSummaryKey(subagent);
			if (sessionKey) nestedAgentSessionKeys.add(sessionKey);
		}
	}
	for (const subagents of codexSubagentsByParent.values()) {
		for (const subagent of subagents) {
			const sessionKey = getSummaryKey(subagent);
			if (sessionKey) nestedAgentSessionKeys.add(sessionKey);
		}
	}

	/** 根据父条目的 filePath（归一化）查找其 pi 原生子会话 */
	const getPiSubagents = (
		parentFilePath?: string,
		environment: SessionEnvironment = "native",
	): SessionSummary[] => {
		if (!parentFilePath) return [];
		const key = getSessionKey(parentFilePath, environment);
		if (!key) return [];
		return piSubagentsByParent.get(key) ?? [];
	};

	const children: ProjectChildItem[] = [
		...unkeyedAgents.map<ProjectChildItem>((agent) => ({
			type: "agent",
			key: `agent:${agent.id}`,
			agent,
			sortAt: agent.createdAt,
			codexSubagents: [],
			piSubagents: [],
		})),
		...[...agentBySessionKey.entries()]
			.filter(([sessionKey]) => !nestedAgentSessionKeys.has(sessionKey))
			.map<ProjectChildItem>(
			([sessionKey, agent]) => {
				const linkedSession = sessionByKey.get(sessionKey);
				if (!linkedSession) {
					return {
						type: "agent",
						key: `agent:${agent.id}`,
						agent,
						sortAt: agent.createdAt,
						codexSubagents: [],
						piSubagents: getPiSubagents(
							agent.sessionPath,
							sessionKey.startsWith("wsl:") ? "wsl" : "native",
						),
					};
				}
				return {
					type: "session",
					key: getSessionRowKey(linkedSession),
					session: linkedSession,
					agent,
					sortAt: getAgentSortAt(agent, sessionByKey),
										codexSubagents: linkedSession
						? (codexSubagentsByParent.get(getCodexParentKey(linkedSession)) ?? [])
						: [],
					// Agent 激活后父会话在 projectSessions 中被滤掉 → linkedSession 可能为 undefined；
				// 此时仍通过 agent.sessionPath 查找子会话，避免父链接丢失导致子会话降级为孤儿。
				piSubagents: getPiSubagents(
					linkedSession?.filePath ?? agent.sessionPath,
					linkedSession
						? getSessionEnvironment(linkedSession)
						: (sessionKey.startsWith("wsl:") ? "wsl" : "native"),
				),
				};
			},
		),
		...[...sessionByKey.entries()]
			.filter(([sessionKey]) => !agentBySessionKey.has(sessionKey))
			.map<ProjectChildItem>(([sessionKey, session]) => ({
				type: "session",
				key: getSessionRowKey(session),
				session,
				sortAt: session.updatedAt,
				codexSubagents: codexSubagentsByParent.get(getCodexParentKey(session)) ?? [],
				piSubagents: getPiSubagents(
					session.filePath,
					getSessionEnvironment(session),
				),
			})),
		...unkeyedSessions.map<ProjectChildItem>((session) => ({
			type: "session",
			key: getSessionRowKey(session),
			session,
			sortAt: session.updatedAt,
			codexSubagents: codexSubagentsByParent.get(getCodexParentKey(session)) ?? [],
			piSubagents: getPiSubagents(
				session.filePath,
				getSessionEnvironment(session),
			),
		})),
	];

	children.sort((left, right) => right.sortAt - left.sortAt);

	const limit = visibleChildCount ?? DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT;
	const visibleChildren = children.slice(0, limit);
	return {
		children,
		visibleChildren,
		hiddenChildCount: Math.max(0, children.length - visibleChildren.length),
	};
}
