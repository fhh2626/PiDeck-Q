import type { AgentUiResponse } from '../../../shared/types';
/**
 * WebChatApp — PiDeck Web 服务 React 前端（A2）重构后的组合根。
 *
 * 数据层保持原有架构：
 * - useChat + DefaultChatTransport 消费 /api/chat 流式（AI SDK v7 UIMessageStream）
 * - /api/state 低频轮询兜底项目/会话/运行态
 * - 历史消息按会话注入 useChat；useChat 切换 id 会重建 Chat 实例（不保留
 *   上一会话消息），因此本组件持有自己的 per-session 消息缓存，
 *   切回会话时直接从缓存恢复，避免重复拉取与闪空。
 *
 * UI 层与桌面端对齐：WebSidebar / WebHeader / WebTimeline / WebComposer，
 * 复用桌面设计 token、shadcn 组件、lucide 图标与 timeline/surfaces 样式类。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import type { AvailableModel } from "../../../shared/types";
import { t } from "@/i18n";
import { WebSidebar } from "./WebSidebar";
import { WebHeader, type WebHeaderStatus } from "./WebHeader";
import { WebTimeline } from "./WebTimeline";
import { WebComposer } from "./WebComposer";
import {
	respondToUi,
	chatMessagesToUiMessages,
	createProject,
	createSession,
	deleteProject,
	fetchMessagePage,
	fetchModels,
	fetchState,
	mergeAuthoritativeUiMessages,
	abortRuntime,
	setRuntimeModel,
	setRuntimeThinking,
	updateSessionRecord,
} from "./webApi";
import type { WebPendingUiRequest, WebProject, WebState } from "./webTypes";
import {
	markWebStateFailure,
	markWebStateSuccess,
	WEB_STATE_POLL_MS,
	type WebConnectionSnapshot,
} from "./webConnection";
import { canRequestWebHistoryPage, hasMoreWebHistory, type WebHistoryMeta } from "./webHistory";

export function WebChatApp() {
	const [state, setState] = useState<WebState>({
		projects: [],
		sessions: [],
		runtimes: [],
		messagesBySession: {},
	});
	const [activeSessionId, setActiveSessionId] = useState<string>("");
	const [creatingProjectId, setCreatingProjectId] = useState<string>("");
	const [connected, setConnected] = useState(false);
	const connectionRef = useRef<WebConnectionSnapshot>({ connected: false, failures: 0 });
	const [loadingMore, setLoadingMore] = useState(false);
	const [historyEpoch, setHistoryEpoch] = useState(0);
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [commandError, setCommandError] = useState<string | null>(null);
	// 首页（无会话）时选择的模型/思考级别：暂存为待用偏好，随下一次新建会话生效
	const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
	const [pendingThinkingLevel, setPendingThinkingLevel] = useState<string | null>(null);
	// 手机端默认把聊天作为主画面，项目树通过抽屉按需打开，避免列表占满首屏。
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

	// Mobile Safari/Chrome keep 100vh on the layout viewport. The address bar and
	// keyboard change visualViewport metrics; syncing the whole rectangle keeps
	// the shell and its drawer aligned with what the user can actually see.
	useEffect(() => {
		const updateViewportMetrics = () => {
			const viewport = window.visualViewport;
			const height = viewport?.height ?? window.innerHeight;
			const width = viewport?.width ?? window.innerWidth;
			const offsetTop = Math.max(0, viewport?.offsetTop ?? 0);
			const offsetLeft = Math.max(0, viewport?.offsetLeft ?? 0);
			document.documentElement.style.setProperty("--web-viewport-height", `${height}px`);
			document.documentElement.style.setProperty("--web-viewport-width", `${width}px`);
			document.documentElement.style.setProperty("--web-viewport-offset-left", `${offsetLeft}px`);
			document.documentElement.style.setProperty("--web-viewport-offset-top", `${offsetTop}px`);
		};
		const viewport = window.visualViewport;
		updateViewportMetrics();
		viewport?.addEventListener("resize", updateViewportMetrics);
		viewport?.addEventListener("scroll", updateViewportMetrics);
		window.addEventListener("resize", updateViewportMetrics);
		return () => {
			viewport?.removeEventListener("resize", updateViewportMetrics);
			viewport?.removeEventListener("scroll", updateViewportMetrics);
			window.removeEventListener("resize", updateViewportMetrics);
			document.documentElement.style.removeProperty("--web-viewport-height");
			document.documentElement.style.removeProperty("--web-viewport-width");
			document.documentElement.style.removeProperty("--web-viewport-offset-left");
			document.documentElement.style.removeProperty("--web-viewport-offset-top");
		};
	}, []);

	// ── 本组件自持的 per-session 消息缓存（useChat 切换 id 会重建 Chat 实例） ──
	const messagesBySessionRef = useRef<Record<string, UIMessage[]>>({});
	const loadedSessionsRef = useRef<Set<string>>(new Set());
	const historyMetaRef = useRef<Record<string, WebHistoryMeta>>({});
	const bumpHistory = useCallback(() => {
		setHistoryEpoch((value) => value + 1);
	}, []);
	const historyRequestSequenceRef = useRef<Record<string, number>>({});
	const activeSessionIdRef = useRef<string>("");
	const streamingRef = useRef(false);
	// 同一条断线只启动一次恢复；重新收到实时帧后释放，允许后续独立断线再次恢复。
	const recoveringStreamSessionRef = useRef<string | null>(null);
	// 首页直发暂存：新建会话后等 useChat 实例切换完成，再投递首条消息
	const pendingSendRef = useRef<{ sessionId: string; text: string } | null>(null);

	// useChat：sessionId 作为 chat id；发送仍走 POST /api/chat，断线恢复只订阅
	// GET /api/sessions/:id/stream，避免重新提交 prompt。
	const chatTransport = useMemo(() => new DefaultChatTransport({
		api: "/api/chat",
		prepareReconnectToStreamRequest: ({ id }) => ({
			api: `/api/sessions/${encodeURIComponent(id)}/stream`,
		}),
	}), []);
	const { messages, sendMessage, status, stop, setMessages, error, resumeStream } = useChat({
		id: activeSessionId,
		transport: chatTransport,
	});

	const streaming = status === "submitted" || status === "streaming";

	activeSessionIdRef.current = activeSessionId;
	streamingRef.current = streaming;

	useEffect(() => {
		// 只有真正收到恢复流帧进入 streaming，才允许该会话下一次断线再触发恢复。
		if (status === "streaming") recoveringStreamSessionRef.current = null;
	}, [status]);

	useEffect(() => {
		if (recoveringStreamSessionRef.current !== activeSessionId) {
			recoveringStreamSessionRef.current = null;
		}
	}, [activeSessionId]);

	/** 将主进程运行时尾部快照合并回 Web 缓存，避免轮询覆盖正在显示的流。 */
	const syncRuntimeMessages = useCallback((nextState: WebState, sessionId: string) => {
		if (!sessionId) return;
		const snapshot = nextState.messagesBySession[sessionId];
		if (!snapshot) return;
		const authoritative = chatMessagesToUiMessages(snapshot);
		const current = messagesBySessionRef.current[sessionId] ?? [];
		const idle = !streamingRef.current;
		const merged = mergeAuthoritativeUiMessages(current, authoritative, {
			dropUnmatchedTrailingPlaceholders: idle,
		});
		messagesBySessionRef.current[sessionId] = merged;
		// 流式期间由 SSE/useChat 保持逐 token 画面；状态快照只更新缓存，
		// 等状态变为空闲后再替换为主进程的最终消息。
		// 主进程运行时快照只含尾部窗口。空闲后如果直接整表替换，
		// 刚结束的 SSE 回复可能被更早的投影片段覆盖，表现为“这条没回、下一条回了两次”。
		if (idle && activeSessionIdRef.current === sessionId && merged !== current) {
			setMessages(merged);
		}
	}, [setMessages]);

	const runtimeFor = (sessionId: string) =>
		state.runtimes.find((runtime) => runtime.sessionId === sessionId);
	const activeSession = state.sessions.find((session) => session.id === activeSessionId);
	const activeRuntime = activeSessionId ? runtimeFor(activeSessionId) : undefined;

	// 切换会话：优先从缓存恢复；未加载过则拉取历史页注入
	useEffect(() => {
		if (!activeSessionId) return;
		if (loadedSessionsRef.current.has(activeSessionId)) {
			setMessages(messagesBySessionRef.current[activeSessionId] ?? []);
			return;
		}
		const sessionId = activeSessionId;
		const requestSequence = (historyRequestSequenceRef.current[sessionId] ?? 0) + 1;
		historyRequestSequenceRef.current[sessionId] = requestSequence;
		void fetchMessagePage(sessionId)
			.then((page) => {
				if (historyRequestSequenceRef.current[sessionId] !== requestSequence) return;
				const history = chatMessagesToUiMessages(page.messages);
				const cached = messagesBySessionRef.current[sessionId] ?? [];
				const merged = mergeAuthoritativeUiMessages(history, cached);
				messagesBySessionRef.current[sessionId] = merged;
				historyMetaRef.current[sessionId] = {
					total: page.total,
					nextBefore: page.nextBefore,
					nextBeforeEntryId: page.nextBeforeEntryId,
					indexVersion: page.indexVersion,
					status: "ready",
				};
				loadedSessionsRef.current.add(sessionId);
				bumpHistory();
				// 仅当仍停留在该会话时才注入（避免切走后 setMessages 串台）
				if (activeSessionIdRef.current === sessionId && !streamingRef.current) {
					setMessages(merged);
				}
			})
			.catch(() => {
				if (historyRequestSequenceRef.current[sessionId] !== requestSequence) return;
				historyMetaRef.current[sessionId] = {
					total: historyMetaRef.current[sessionId]?.total ?? 0,
					nextBefore: null,
					status: "error",
				};
				bumpHistory();
				if (activeSessionIdRef.current === sessionId) setCommandError(t("web.historyLoadFailed"));
			});
	}, [activeSessionId, bumpHistory, setMessages]);

	// SSE 异常先以权威快照建立新基线；runtime 仍在运行时只重订阅 session stream，
	// 绝不重试 POST /api/chat，避免同一 prompt 被再次发送。
	useEffect(() => {
		if (!error || !activeSessionId) return;
		const sessionId = activeSessionId;
		if (recoveringStreamSessionRef.current === sessionId) return;
		recoveringStreamSessionRef.current = sessionId;
		const requestSequence = (historyRequestSequenceRef.current[sessionId] ?? 0) + 1;
		historyRequestSequenceRef.current[sessionId] = requestSequence;
		void (async () => {
			try {
				const nextState = await fetchState();
				if (
					historyRequestSequenceRef.current[sessionId] !== requestSequence ||
					activeSessionIdRef.current !== sessionId
				) return;
				setState(nextState);
				syncRuntimeMessages(nextState, sessionId);
				const runtimeStillRunning = nextState.runtimes.some(
					(runtime) => runtime.sessionId === sessionId && runtime.status === "running",
				);

				const page = await fetchMessagePage(sessionId);
				if (
					historyRequestSequenceRef.current[sessionId] !== requestSequence ||
					activeSessionIdRef.current !== sessionId
				) return;
				const history = chatMessagesToUiMessages(page.messages);
				const runtimeSnapshot = chatMessagesToUiMessages(
					nextState.messagesBySession[sessionId] ?? [],
				);
				// 历史页可能尚未落盘当前 reasoning；把同一次 state 请求拿到的 runtime
				// 快照叠到历史尾部，形成 reconnect 前的完整 authoritative 基线。
				const authoritative = mergeAuthoritativeUiMessages(history, runtimeSnapshot);
				const merged = mergeAuthoritativeUiMessages(
					messagesBySessionRef.current[sessionId] ?? [],
					authoritative,
					{ dropUnmatchedTrailingPlaceholders: true },
				);
				messagesBySessionRef.current[sessionId] = merged;
				historyMetaRef.current[sessionId] = {
					total: page.total,
					nextBefore: page.nextBefore,
					nextBeforeEntryId: page.nextBeforeEntryId,
					indexVersion: page.indexVersion,
					status: "ready",
				};
				loadedSessionsRef.current.add(sessionId);
				bumpHistory();
				setMessages(merged);

				if (runtimeStillRunning) {
					setCommandError(null);
					await resumeStream();
					return;
				}
				recoveringStreamSessionRef.current = null;
				setCommandError(t("web.streamFailed"));
			} catch {
				if (activeSessionIdRef.current === sessionId) {
					recoveringStreamSessionRef.current = null;
					setCommandError(t("web.historyLoadFailed"));
				}
			}
		})();
	}, [activeSessionId, bumpHistory, error, resumeStream, setMessages, syncRuntimeMessages]);

	// 轮询拿到的运行时快照也要在切换会话/流结束后立即回放，
	// 否则 Web 只显示自己发出的 SSE，PC 端新增的消息永远要等重新打开页面才出现。
	useEffect(() => {
		if (!activeSessionId || streaming) return;
		syncRuntimeMessages(state, activeSessionId);
	}, [activeSessionId, state, streaming, syncRuntimeMessages]);

	// 流式期间同步缓存：仅 streaming 时合并（空闲时 setMessages 来自历史恢复/分页，
	// 对应逻辑已各自写缓存）。运行时 useChat 可能只保留尾部窗口，不能直接覆盖缓存，
	// 否则用户已经「加载更多」prepend 的旧页会在下一次发送后全部丢失。
	// 不要把会话标成 loaded：那是「首页已经成功」的语义。流式先标 loaded
	// 会让 handleLoadMore 在还没拿到 nextBefore 时直接 return，点按钮没反应。
	useEffect(() => {
		if (!activeSessionId || !streaming) return;
		messagesBySessionRef.current[activeSessionId] = mergeAuthoritativeUiMessages(
			messagesBySessionRef.current[activeSessionId] ?? [],
			messages,
		);
	}, [messages, activeSessionId, streaming]);

	// 首页直发：useChat 随 activeSessionId 切换在渲染期重建实例（@ai-sdk/react 在 render 中
	// 直接替换 chatRef.current），因此本 effect 里拿到的 sendMessage 已属于新会话；
	// 用 sessionId 校验防止用户在创建期间切到其他会话后串台。
	useEffect(() => {
		const pending = pendingSendRef.current;
		if (!pending || pending.sessionId !== activeSessionId) return;
		if (streaming) return; // 新实例就绪（空闲）后才投递
		pendingSendRef.current = null;
		void sendMessage({ text: pending.text });
	}, [activeSessionId, streaming, sendMessage]);

	// 模型列表是全局 pi 配置，草稿会话也需要先选模型再发送第一条消息。
	useEffect(() => {
		void fetchModels().then(setModels).catch(() => setModels([]));
	}, []);

	// 低频轮询项目/会话/运行态（3s；useChat 负责消息流，不参与轮询）
	useEffect(() => {
		let disposed = false;
		const refresh = async () => {
			try {
				const next = await fetchState();
				if (disposed) return;
				setState(next);
				syncRuntimeMessages(next, activeSessionIdRef.current);
				const nextConnection = markWebStateSuccess();
				connectionRef.current = nextConnection;
				setConnected(nextConnection.connected);
				// 清理已被外部删除的会话缓存
				const validSessionIds = new Set(next.sessions.map((s) => s.id));
				for (const id of Object.keys(messagesBySessionRef.current)) {
					if (!validSessionIds.has(id)) {
						delete messagesBySessionRef.current[id];
						delete historyMetaRef.current[id];
						loadedSessionsRef.current.delete(id);
					}
				}
				// 初始页面保持空会话，让用户明确选择项目/会话；外部删除当前会话时也回到空状态。
				if (activeSessionIdRef.current && !next.sessions.some((session) => session.id === activeSessionIdRef.current)) {
					setActiveSessionId("");
				}
			} catch {
				if (disposed) return;
				const nextConnection = markWebStateFailure(connectionRef.current);
				connectionRef.current = nextConnection;
				setConnected(nextConnection.connected);
			}
		};
		void refresh();
		const timer = setInterval(refresh, WEB_STATE_POLL_MS);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
		// activeSessionId 变化后下一轮轮询会补齐最新状态，不必重启轮询
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [syncRuntimeMessages]);

	const [uiResponding, setUiResponding] = useState(false);

	// 当前会话的 pending 提问：取最后一条（最新到达的），与桌面 pickActiveAskRequest
	// 的「展示最新」语义一致——否则挂着旧 select 时会遮蔽真正要回答的那条。
	const activePendingUiRequest = useMemo(() => {
		const list = (state.pendingUiRequests ?? []).filter(
			(item) => item.sessionId === activeSessionId,
		);
		return list.length > 0 ? list[list.length - 1] : undefined;
	}, [state.pendingUiRequests, activeSessionId]);

	// 提交 pending 卡回答。responder 把「当前这条 request」随响应带回，
	// 避免轮询快照过期后答错请求。
	const handleRespondUi = async (
		request: WebPendingUiRequest,
		response: AgentUiResponse,
	): Promise<boolean> => {
		if (uiResponding) return false;
		setUiResponding(true);
		setCommandError(null);
		try {
			await respondToUi({
				sessionId: request.sessionId,
				requestId: request.requestId,
				agentId: request.agentId,
				runtimeGeneration: request.runtimeGeneration,
				response,
			});
			await refreshNow();
			return true;
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			setUiResponding(false);
		}
	};

	const handleSend = (text: string) => {
		if (!text.trim()) return;
		if (!activeSessionId) {
			// 首页直发：无会话时自动新建会话（携带已选模型/思考级别）再投递首条消息
			void sendFromHome(text);
			return;
		}
		void sendMessage({ text });
	};

	const handleStop = () => {
		stop();
		if (!activeRuntime) return;
		void abortRuntime({
			sessionId: activeRuntime.sessionId,
			agentId: activeRuntime.agentId,
			runtimeGeneration: activeRuntime.runtimeGeneration ?? 0,
		}).catch((error) => {
			setCommandError(error instanceof Error ? error.message : String(error));
		});
	};

	// 首页直发流程：优先内置 chat 项目（未配置项目时的兜底），否则取第一个项目；
	// 创建期间复用 creatingProjectId 短暂禁用输入，防止重复提交。
	const sendFromHome = async (text: string) => {
		const project = state.projects.find((candidate) => candidate.kind === "chat") ?? state.projects[0];
		if (!project) {
			setCommandError(t("web.sendNoProject"));
			return;
		}
		setCreatingProjectId(project.id);
		setCommandError(null);
		try {
			const id = await createSession(project.id, {
				...(pendingModel ? { model: pendingModel } : {}),
				...(pendingThinkingLevel ? { thinkingLevel: pendingThinkingLevel } : {}),
			});
			markSessionLoaded(id);
			setActiveSessionId(id);
			setMobileSidebarOpen(false);
			// 会话 id 变化后 useChat 重建实例；等新实例就绪再投递（见上方 effect）
			pendingSendRef.current = { sessionId: id, text };
			await refreshNow();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		} finally {
			setCreatingProjectId("");
		}
	};

	// 新会话无历史：预标记为已加载（空缓存），避免切过去时多余拉取
	const markSessionLoaded = (id: string) => {
		loadedSessionsRef.current.add(id);
		messagesBySessionRef.current[id] = [];
		historyMetaRef.current[id] = { total: 0, nextBefore: null, status: "ready" };
		bumpHistory();
	};

	const handleCreateSession = async (projectId: string) => {
		setCreatingProjectId(projectId);
		setCommandError(null);
		try {
			const id = await createSession(projectId, {
				...(pendingModel ? { model: pendingModel } : {}),
				...(pendingThinkingLevel ? { thinkingLevel: pendingThinkingLevel } : {}),
			});
			markSessionLoaded(id);
			setActiveSessionId(id);
			setMobileSidebarOpen(false);
			await refreshNow();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		} finally {
			setCreatingProjectId("");
		}
	};

	const handleCreateProject = async (path: string): Promise<WebProject> => {
		setCommandError(null);
		try {
			const project = await createProject(path);
			await refreshNow();
			return project;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setCommandError(message);
			throw error;
		}
	};

	const handleDeleteProject = async (projectId: string) => {
		setCommandError(null);
		try {
			const deletedSessions = state.sessions.filter((session) => session.projectId === projectId);
			await deleteProject(projectId);
			for (const session of deletedSessions) {
				delete messagesBySessionRef.current[session.id];
				delete historyMetaRef.current[session.id];
				loadedSessionsRef.current.delete(session.id);
			}
			setState((current) => ({
				...current,
				projects: current.projects.filter((project) => project.id !== projectId),
				sessions: current.sessions.filter((session) => session.projectId !== projectId),
				runtimes: current.runtimes.filter((runtime) => !deletedSessions.some((session) => session.id === runtime.sessionId)),
			}));
			if (deletedSessions.some((session) => session.id === activeSessionId)) {
				setActiveSessionId("");
			}
			setMobileSidebarOpen(false);
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const updateActiveSessionState = (patch: { model?: { provider: string; modelId: string }; thinkingLevel?: string }) => {
		setState((current) => ({
			...current,
			sessions: current.sessions.map((session) =>
				session.id === activeSessionId ? { ...session, ...patch } : session,
			),
		}));
	};

	const handleModelChange = async (model: AvailableModel) => {
		if (!activeSessionId) {
			// 首页无会话：选择暂存为待用偏好，新建会话时生效
			setPendingModel({ provider: model.provider, modelId: model.id });
			return;
		}
		setCommandError(null);
		try {
			if (activeRuntime) {
				await setRuntimeModel(
					{
						sessionId: activeRuntime.sessionId,
						agentId: activeRuntime.agentId,
						runtimeGeneration: activeRuntime.runtimeGeneration ?? 0,
					},
					model.provider,
					model.id,
				);
			} else {
				await updateSessionRecord(activeSessionId, {
					model: { provider: model.provider, modelId: model.id },
				});
			}
			updateActiveSessionState({ model: { provider: model.provider, modelId: model.id } });
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const handleThinkingChange = async (level: string) => {
		if (!activeSessionId) {
			// 首页无会话：选择暂存为待用偏好，新建会话时生效
			setPendingThinkingLevel(level);
			return;
		}
		setCommandError(null);
		try {
			if (activeRuntime) {
				await setRuntimeThinking(
					{
						sessionId: activeRuntime.sessionId,
						agentId: activeRuntime.agentId,
						runtimeGeneration: activeRuntime.runtimeGeneration ?? 0,
					},
					level,
				);
			} else {
				await updateSessionRecord(activeSessionId, { thinkingLevel: level });
			}
			updateActiveSessionState({ thinkingLevel: level });
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const refreshNow = async () => {
		try {
			const next = await fetchState();
			setState(next);
			syncRuntimeMessages(next, activeSessionIdRef.current);
			const nextConnection = markWebStateSuccess();
			connectionRef.current = nextConnection;
			setConnected(nextConnection.connected);
		} catch {
			const nextConnection = markWebStateFailure(connectionRef.current);
			connectionRef.current = nextConnection;
			setConnected(nextConnection.connected);
		}
	};

	const handleLoadMore = async () => {
		if (!activeSessionId || loadingMore) return;
		const sessionId = activeSessionId;
		const meta = historyMetaRef.current[sessionId];
		const alreadyLoaded = loadedSessionsRef.current.has(sessionId);
		// 首页失败 / 尚未拉过 / 流式提前标了缓存：重新拉尾页；已有游标：继续往更早翻。
		if (!canRequestWebHistoryPage({ loaded: alreadyLoaded, meta })) return;
		const requestSequence = (historyRequestSequenceRef.current[sessionId] ?? 0) + 1;
		historyRequestSequenceRef.current[sessionId] = requestSequence;
		setLoadingMore(true);
		try {
			const page = await fetchMessagePage(
				sessionId,
				meta?.nextBefore != null ? meta.nextBefore : undefined,
			);
			if (
				historyRequestSequenceRef.current[sessionId] !== requestSequence ||
				activeSessionIdRef.current !== sessionId
			) return;
			historyMetaRef.current[sessionId] = {
				total: page.total,
				nextBefore: page.nextBefore,
				nextBeforeEntryId: page.nextBeforeEntryId,
				indexVersion: page.indexVersion,
				status: "ready",
			};
			const older = chatMessagesToUiMessages(page.messages);
			const merged = meta?.nextBefore != null
				? [...older, ...(messagesBySessionRef.current[sessionId] ?? [])]
				: mergeAuthoritativeUiMessages(older, messagesBySessionRef.current[sessionId] ?? []);
			messagesBySessionRef.current[sessionId] = merged;
			loadedSessionsRef.current.add(sessionId);
			bumpHistory();
			// merged 基于每个流式增量都会更新的 per-session 缓存，既含当前回复也含旧页；
			// 因此可以直接注入 useChat，让思考/回答期间点击「加载更多」立即可见。
			setMessages(merged);
		} catch {
			if (historyRequestSequenceRef.current[sessionId] !== requestSequence) return;
			historyMetaRef.current[sessionId] = {
				total: historyMetaRef.current[sessionId]?.total ?? 0,
				nextBefore: historyMetaRef.current[sessionId]?.nextBefore ?? null,
				status: "error",
			};
			bumpHistory();
			if (activeSessionIdRef.current === sessionId) setCommandError(t("web.historyLoadFailed"));
		} finally {
			setLoadingMore(false);
		}
	};

	// 头部运行态：流式优先；否则用轮询到的 runtime 状态兜底
	const headerStatus: WebHeaderStatus = (() => {
		if (streaming) return "running";
		const runtimeStatus = activeRuntime?.status;
		if (runtimeStatus === "starting") return "starting";
		if (runtimeStatus === "running") return "running";
		if (runtimeStatus === "error") return "error";
		return "idle";
	})();

	void historyEpoch;
	const activeMeta = activeSessionId ? historyMetaRef.current[activeSessionId] : undefined;
	const hasMoreHistory = Boolean(activeSessionId) && hasMoreWebHistory({
		meta: activeMeta,
		loaded: loadedSessionsRef.current.has(activeSessionId),
		catalogMessageCount: activeSession?.messageCount,
	});
	const moreCount = activeMeta
		? Math.max(0, activeMeta.total - (messagesBySessionRef.current[activeSessionId]?.length ?? 0))
		: Math.max(0, activeSession?.messageCount ?? 0);

	return (
		<div className="app wechat-shell flex h-full w-full min-w-0 overflow-hidden bg-background text-foreground">
			<WebSidebar
				state={state}
				activeSessionId={activeSessionId}
				creatingProjectId={creatingProjectId}
				connected={connected}
				mobileOpen={mobileSidebarOpen}
				onCloseMobile={() => setMobileSidebarOpen(false)}
				onSelectSession={(sessionId) => {
					setActiveSessionId(sessionId);
					setMobileSidebarOpen(false);
				}}
				onCreateSession={(projectId) => void handleCreateSession(projectId)}
				onCreateProject={handleCreateProject}
				onDeleteProject={handleDeleteProject}
			/>
			<main className="chat-pane flex h-full min-w-0 flex-1 flex-col overflow-hidden">
				<WebHeader
					title={activeSession?.title || t("web.chooseSession")}
					status={headerStatus}
					sessionId={activeSessionId}
					onOpenSidebar={() => setMobileSidebarOpen(true)}
					model={activeSession?.model ?? pendingModel ?? undefined}
					thinkingLevel={activeSession?.thinkingLevel ?? pendingThinkingLevel ?? undefined}
					models={models}
					onModelChange={(model) => void handleModelChange(model)}
					onThinkingChange={(level) => void handleThinkingChange(level)}
				/>
				<WebTimeline
					messages={messages}
					hasActiveSession={Boolean(activeSession)}
					hasMoreHistory={hasMoreHistory}
					moreCount={moreCount}
					loadingMore={loadingMore}
					streaming={streaming}
					error={error?.message ?? commandError}
					pendingUiRequest={activePendingUiRequest}
					onRespondUi={handleRespondUi}
					onLoadMore={() => void handleLoadMore()}
				/>
				<WebComposer
					disabled={Boolean(creatingProjectId)}
					streaming={streaming}
					onSend={handleSend}
					onStop={handleStop}
				/>
			</main>
		</div>
	);
}
