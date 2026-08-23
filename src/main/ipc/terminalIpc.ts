import { ipcChannels } from "../../shared/ipc";
import type { SessionCommandError, SessionRuntimeTarget, TerminalTarget } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { RpcRouter } from "../transport/RpcRouter";

export type TerminalIpcDeps = {
	appLogger: Pick<AppLogger, "info">;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	terminalManager: TerminalSessionManager;
	toSessionCommandIpcError: (error: SessionCommandError) => Error;
};

export function registerTerminalIpc(
	router: RpcRouter,
	{
		appLogger,
		sessionRuntimeCoordinator,
		terminalManager,
		toSessionCommandIpcError,
	}: TerminalIpcDeps,
): void {
	/**
	 * 终端目标必须可落地：agent 目标校验 runtime 绑定（session/agent/generation 一致）；
	 * project 目标（引导页/未激活 agent/历史会话）不依赖 runtime，直接以 cwd 隔离。
	 */
	const requireTerminalTarget = (target: TerminalTarget) => {
		if (target.kind === "project") {
			// cwd 为渲染层传来的项目路径，仅作为 shell 启动目录与隔离键，不做额外校验
			return target;
		}
		const validated = sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) throw toSessionCommandIpcError(validated.error);
		return validated;
	};

	router.handle(ipcChannels.terminalList, (target: TerminalTarget) => {
		requireTerminalTarget(target);
		return terminalManager.list(target);
	});
	router.handle(ipcChannels.terminalEnsure, (target: TerminalTarget) => {
		requireTerminalTarget(target);
		return terminalManager.ensure(target);
	});
	router.handle(ipcChannels.terminalCreate, async (target: TerminalTarget) => {
		requireTerminalTarget(target);
		const result = await terminalManager.create(target);
		void appLogger.info("terminal", "Terminal created", {
			kind: target.kind,
			sessionId: target.kind === "agent" ? target.sessionId : undefined,
			agentId: target.kind === "agent" ? target.agentId : undefined,
			tabId: result.id,
		});
		return result;
	});
	router.handle(
		ipcChannels.terminalInput,
		(tabId: string, data: string) => {
			terminalManager.input(tabId, data);
		},
	);
	router.handle(
		ipcChannels.terminalResize,
		(tabId: string, cols: number, rows: number) => {
			terminalManager.resize(tabId, cols, rows);
		},
	);
	router.handle(ipcChannels.terminalClose, (tabId: string) => {
		terminalManager.close(tabId);
		void appLogger.info("terminal", "Terminal closed", { tabId });
	});
}
