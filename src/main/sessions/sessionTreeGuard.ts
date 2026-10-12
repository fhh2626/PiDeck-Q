import { canonicalizeSessionPath } from "../../shared/sessionIdentity";
import type { SessionEnvironment } from "../../shared/types";

/** 守卫只关心这些字段；用窄类型方便测试构造。 */
export type SessionTreeEntry = {
	id: string;
	filePath?: string;
	environment: SessionEnvironment;
	wslDistro?: string;
	wslUser?: string;
};

export type SessionTreeAgent = {
	title: string;
	sessionPath?: string;
	sessionEnvironment?: SessionEnvironment;
	wslDistro?: string;
	wslUser?: string;
};

export type SessionTreeGuardDeps = {
	listEntries: () => SessionTreeEntry[];
	listAgents: () => SessionTreeAgent[];
	/** 会话已绑定 runtime、正在激活或匿名激活中时返回 true。 */
	isSessionBusy: (sessionId: string) => boolean;
};

export type SessionTreeBlock =
	| { kind: "session-busy"; sessionId: string }
	| { kind: "file-in-use"; agentTitle: string };

function sameEnvironment(a: SessionTreeEntry, b: { environment?: SessionEnvironment; wslDistro?: string; wslUser?: string }): boolean {
	if (a.environment !== b.environment) return false;
	if (a.environment !== "wsl") return true;
	return a.wslDistro === b.wslDistro && a.wslUser === b.wslUser;
}

/**
 * 删除/归档 <stem>.jsonl 会连带移动 <stem>/ 下的全部子会话。
 * 判断“这次操作会影响哪些会话”必须覆盖整棵树：父文件本身 + 子目录内任意深度的 JSONL。
 */
export function isPathInSessionTree(rootFile: string, candidate: string, environment: SessionEnvironment): boolean {
	const root = canonicalizeSessionPath(rootFile, environment);
	const target = canonicalizeSessionPath(candidate, environment);
	if (target === root) return true;
	if (!root.endsWith(".jsonl")) return false;
	// 末尾的 / 是必需的：否则 same-other.jsonl 会被误判成 same.jsonl 的子会话。
	const childDir = `${root.slice(0, -".jsonl".length)}/`;
	return target.startsWith(childDir);
}

/** 返回第一个阻止操作的原因；整棵树都空闲时返回 null。 */
export function findSessionTreeBlock(root: SessionTreeEntry, deps: SessionTreeGuardDeps): SessionTreeBlock | null {
	if (deps.isSessionBusy(root.id)) return { kind: "session-busy", sessionId: root.id };
	if (!root.filePath) return null;
	for (const entry of deps.listEntries()) {
		if (entry.id === root.id || !entry.filePath || !sameEnvironment(root, entry)) continue;
		if (isPathInSessionTree(root.filePath, entry.filePath, root.environment) && deps.isSessionBusy(entry.id)) {
			return { kind: "session-busy", sessionId: entry.id };
		}
	}
	for (const agent of deps.listAgents()) {
		if (!agent.sessionPath) continue;
		if (!sameEnvironment(root, { environment: agent.sessionEnvironment, wslDistro: agent.wslDistro, wslUser: agent.wslUser })) continue;
		if (isPathInSessionTree(root.filePath, agent.sessionPath, root.environment)) {
			return { kind: "file-in-use", agentTitle: agent.title };
		}
	}
	return null;
}
