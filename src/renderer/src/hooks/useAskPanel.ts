import { useCallback } from "react";
import { useAtom, useStore } from "jotai";
import {
	askPanelCreatingAtom,
	askPanelOpenAtom,
	askPanelSessionIdAtom,
} from "../atoms/ask-panel-atoms";
import { sessionRecordsAtom } from "../atoms/session-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

/**
 * 并行问询：
 * - sendToAsk(projectId, text)：创建/复用匿名会话 → 等 runtime 就绪 → 投递消息 → 显示悬浮胶囊。
 *   匿名会话是独立子进程（noSession 不落盘），与当前会话并行，不打断其输出。
 * - close()：停止匿名 runtime（主进程随后回收 transient 内存）并收起胶囊。
 */
export function useAskPanel() {
	const [isOpen, setOpen] = useAtom(askPanelOpenAtom);
	const [sessionId, setSessionId] = useAtom(askPanelSessionIdAtom);
	const [creating, setCreating] = useAtom(askPanelCreatingAtom);
	const store = useStore();

	// 创建或复用匿名会话；失败返回 null 并 toast
	const ensureSession = useCallback(
		async (projectId: string): Promise<string | null> => {
			if (sessionId) return sessionId;
			setCreating(true);
			try {
				const { session } = await desktopApi.sessions.createAnonymous({
					projectId,
					title: t("askPanel.sessionTitle"),
				});
				// 只登记会话记录供 timeline 渲染，不加入 sessionIdsByProjectAtom：
				// 匿名会话不落盘、不该出现在左侧项目会话列表（关闭弹框后由 detach 事件清理）
				store.set(sessionRecordsAtom, {
					...store.get(sessionRecordsAtom),
					[session.id]: session,
				});
				setSessionId(session.id);
				return session.id;
			} catch (error) {
				setOpen(false);
				// 会话创建失败属异常，常驻提示直到用户手动关闭
				showNotice(error instanceof Error ? error.message : String(error), Number.POSITIVE_INFINITY, "error");
				return null;
			} finally {
				setCreating(false);
			}
		},
		[sessionId, setCreating, setOpen, setSessionId, store],
	);

	// 轮询等待匿名 runtime 就绪：匿名会话是后台激活（createAnonymous 后主进程
	// 异步 bind+activate），立即 sendPrompt 会因 runtime 未就绪而丢失/失败。
	// 注意 agent 就绪状态是 "idle"（"running" 表示正在处理消息），两者都算可发送。
	const waitRuntimeReady = useCallback(
		async (sessionId: string, timeoutMs = 15000): Promise<boolean> => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
				if (runtime?.status === "running" || runtime?.status === "idle") return true;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			return false;
		},
		[store],
	);

	const sendToAsk = useCallback(
		async (projectId: string, text: string): Promise<boolean> => {
			const id = await ensureSession(projectId);
			if (!id) return false;
			// 胶囊先显示：会话创建/启动需要数秒，先给用户即时反馈（创建中/等待响应状态）
			setOpen(true);
			setCreating(true);
			try {
				if (!(await waitRuntimeReady(id))) {
					// 启动超时提示含「请重试」指引，常驻直到用户手动关闭
					showNotice(t("askPanel.runtimeTimeout"), Number.POSITIVE_INFINITY, "error");
					return false;
				}
				// 直接投递：用户消息由主进程按 sessionId 广播进消息缓存，无需乐观写入
				await desktopApi.sessions.sendPrompt({
					sessionId: id,
					requestId: crypto.randomUUID(),
					message: text,
				});
				return true;
			} catch (error) {
				// 发送失败属会话异常，常驻提示直到用户手动关闭
				showNotice(error instanceof Error ? error.message : String(error), Number.POSITIVE_INFINITY, "error");
				return false;
			} finally {
				setCreating(false);
			}
		},
		[ensureSession, setCreating, setOpen, waitRuntimeReady],
	);

	const close = useCallback(async () => {
		setOpen(false);
		if (!sessionId) return;
		// 停止匿名 runtime：主进程收到 stop 后回收 transient 会话内存并广播 detach
		const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
		if (runtime?.agentId) {
			try {
				await desktopApi.sessions.stopRuntime({
					sessionId,
					agentId: runtime.agentId,
					runtimeGeneration: runtime.runtimeGeneration,
				});
			} catch {
				// 停止失败不阻塞关闭（进程可能已退出）
			}
		}
		setSessionId(null);
	}, [sessionId, setOpen, setSessionId, store]);

	return { isOpen, sessionId, creating, sendToAsk, close };
}
