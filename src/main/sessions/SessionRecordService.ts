import type { ChatMessage, SessionCommandError, SessionRecord, UpdateSessionRecordInput } from "../../shared/types";
import {
	enforceDeliveryBudgetOnPayload,
	stripToolResultForDelivery,
} from "../pi/messageDeliveryBudget";
import type { SessionCatalog } from "./SessionCatalog";
import type { SessionScanner } from "./SessionScanner";
import type { SessionRuntimeCoordinator } from "./SessionRuntimeCoordinator";
import { isSessionDeleteBlocked, SessionDeleteBlockedError } from "./SessionDeleteBlockedError";
import { findSessionTreeBlock, type SessionTreeAgent } from "./sessionTreeGuard";

export type SessionRecordServiceDeps = {
	sessionCatalog: Pick<SessionCatalog, "get" | "update" | "remove" | "listEntries">;
	sessionScanner: Pick<SessionScanner, "rename" | "delete" | "archive" | "readSessionRawText">;
	/** 从会话文件投影显示消息（AgentManager.readSessionDisplayMessages 的注入点）。 */
	readDisplayMessages: (
		filePath: string,
		sessionId: string,
		content: string,
	) => Promise<ChatMessage[]>;
	sessionRuntimeCoordinator: Pick<SessionRuntimeCoordinator, "getTarget" | "isActivating" | "renameRuntime">;
	listAgents: () => SessionTreeAgent[];
	isAnonymousActivating: (sessionId: string) => boolean;
	notifyCatalogRefreshed: (projectId: string) => void;
	toCommandError: (error: SessionCommandError) => Error;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	logger: {
		info: (category: string, message: string, meta?: Record<string, unknown>) => unknown;
		error: (category: string, message: string, meta?: Record<string, unknown>) => unknown;
	};
};

/**
 * 会话记录的唯一业务入口（改名/删除/归档）。
 * 桌面 IPC 与 Web backend 都只调用这里，保证保护逻辑、广播、日志只有一份。
 */
export class SessionRecordService {
	constructor(private readonly deps: SessionRecordServiceDeps) {}

	private isBusy = (sessionId: string): boolean => isSessionDeleteBlocked(sessionId, {
		getTarget: (id) => this.deps.sessionRuntimeCoordinator.getTarget(id),
		isActivating: (id) => this.deps.sessionRuntimeCoordinator.isActivating(id),
		isAnonymousActivating: this.deps.isAnonymousActivating,
	});

	/** 整棵会话树空闲才允许删除/归档/按文件改名。 */
	private assertTreeIdle(sessionId: string): void {
		const entry = this.deps.sessionCatalog.get(sessionId);
		if (!entry) return;
		const block = findSessionTreeBlock(entry, {
			listEntries: () => this.deps.sessionCatalog.listEntries(),
			listAgents: this.deps.listAgents,
			isSessionBusy: this.isBusy,
		});
		if (!block) return;
		if (block.kind === "file-in-use") {
			throw new SessionDeleteBlockedError(
				this.deps.mainCopy("session.inUseDeleteBlocked", { title: block.agentTitle }),
			);
		}
		// 父会话自己在跑 → 提示先停止它；子会话在跑 → 提示先停止子会话。
		if (block.sessionId === sessionId) {
			throw new SessionDeleteBlockedError(this.deps.mainCopy("session.stopBeforeDelete"));
		}
		throw new SessionDeleteBlockedError(this.deps.mainCopy("session.childRunningDeleteBlocked"));
	}

	async update(sessionId: string, patch: UpdateSessionRecordInput): Promise<SessionRecord> {
		const entry = this.deps.sessionCatalog.get(sessionId);
		if (!entry) throw new Error(this.deps.mainCopy("session.notFound"));
		const title = patch.title?.trim();
		if (title && title !== entry.title) {
			const target = this.deps.sessionRuntimeCoordinator.getTarget(sessionId);
			if (target) {
				const renamed = await this.deps.sessionRuntimeCoordinator.renameRuntime(target, title);
				if (!renamed.ok) throw this.deps.toCommandError(renamed.error);
			} else if (entry.filePath) {
				// 按文件改名会整体改写 JSONL：任何 Agent 正在使用该文件时禁止（见 A5 的已知限制）。
				this.assertTreeIdle(sessionId);
				await this.deps.sessionScanner.rename(entry.filePath, title);
				void this.deps.logger.info("session", "Session renamed (file)", {
					sessionId,
					oldTitle: entry.title,
					newTitle: title,
				});
			}
		}
		const record = await this.deps.sessionCatalog.update(sessionId, { ...patch, title: title || undefined });
		this.deps.notifyCatalogRefreshed(record.projectId);
		return record;
	}

	async delete(sessionId: string): Promise<boolean> {
		const entry = this.deps.sessionCatalog.get(sessionId);
		if (!entry) return false;
		this.assertTreeIdle(sessionId);
		try {
			if (entry.filePath) await this.deps.sessionScanner.delete(entry.filePath);
			await this.deps.sessionCatalog.remove(sessionId);
		} catch (error) {
			// 删除失败（文件删除失败/记录移除失败）也要留痕，便于事后追踪。
			void this.deps.logger.error("session", "Catalog session delete failed", {
				sessionId,
				filePath: entry.filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		void this.deps.logger.info("session", "Catalog session deleted", { sessionId, filePath: entry.filePath });
		this.deps.notifyCatalogRefreshed(entry.projectId);
		return true;
	}

	async archive(sessionId: string): Promise<boolean> {
		const entry = this.deps.sessionCatalog.get(sessionId);
		if (!entry?.filePath) return false;
		this.assertTreeIdle(sessionId);
		const archivedPath = await this.deps.sessionScanner.archive(entry.filePath);
		await this.deps.sessionCatalog.remove(sessionId);
		void this.deps.logger.info("session", "Session archived", { sessionId, archivedPath });
		this.deps.notifyCatalogRefreshed(entry.projectId);
		return true;
	}

	/**
	 * 读一个会话的完整显示消息（无分页），含下发预算保护。
	 *
	 * 桌面与 Web 共用同一条管线：工具图卡在文本里已有紧凑纯文本，meta 里的原始大对象
	 * 只用于主进程「查看完整输出」，下发前必须剔除；否则整个会话的工具结果会重复膨胀，
	 * 甚至撑破 32 MiB 原生帧预算（Web 端之前就漏了这一步）。
	 * 超出预算时先卸图片；仍超限视为不可下发，抛错由调用方转换。
	 */
	async readMessages(sessionId: string): Promise<ChatMessage[]> {
		const entry = this.deps.sessionCatalog.get(sessionId);
		if (!entry?.filePath) return [];
		const content = await this.deps.sessionScanner.readSessionRawText(entry.filePath);
		const rawMessages = await this.deps.readDisplayMessages(entry.filePath, sessionId, content);
		const payload = { messages: stripToolResultForDelivery(rawMessages) };
		const result = enforceDeliveryBudgetOnPayload(payload, (candidate) => ({
			ok: true,
			result: candidate.messages,
		}));
		if (!result.ok) throw new Error("MESSAGE_DELIVERY_TOO_LARGE");
		return result.value.messages;
	}
}
