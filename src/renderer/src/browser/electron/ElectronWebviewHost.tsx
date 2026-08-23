/**
 * Electron <webview> 宿主 adapter：renderer 中唯一知道 Electron webview 的模块。
 *
 * 职责：
 * - 渲染 <webview> 并把 Electron 方法/事件翻译成 BrowserHostApi / BrowserHostEvent；
 * - 吸收 ERR_ABORTED / -3 等预期导航取消（不向 BrowserPanel 泄漏 Electron 错误格式）；
 * - 管理 device UA（mobile/tablet 自定义 UA；PC 恢复该 guest 首次捕获的真实默认 UA）。
 *
 * 不负责：URL normalization、tab/popup 产品策略、外部链接分发（popup 由主进程
 * guest setWindowOpenHandler 接管，Electron 22 起 webview 无 new-window 事件）。
 * 安全边界仍在主进程 browserPanelWebviewHost.ts（partition/权限/preload 清理）。
 */
import { useCallback, useEffect, useRef } from "react";
import type {
	BrowserDeviceProfile,
	BrowserHostApi,
	BrowserHostEvent,
	BrowserHostSurfaceProps,
} from "../BrowserHostApi";
import { isExpectedNavigationAbort } from "./ElectronWebviewNavigation";
import { deviceUserAgent } from "./ElectronWebviewDeviceUA";

/** Electron <webview> 元素的方法子集；仅本文件可见，禁止导出。 */
type ElectronWebviewElement = HTMLElement & {
	loadURL(url: string): Promise<void>;
	goBack(): void;
	goForward(): void;
	reload(): void;
	canGoBack(): boolean;
	canGoForward(): boolean;
	getUserAgent(): string;
	setUserAgent(userAgent: string): void;
};

/**
 * Chromium 用 ERR_ABORTED / error -3 表示旧导航被新导航替换，这是 webview 正常
 * 生命周期，不应作为失败冒泡给 BrowserPanel。判断逻辑见 ElectronWebviewNavigation.ts。
 */

/** Electron webview 原始事件 payload 的最小类型面（仅 adapter 内使用）。 */
type ElectronWebviewEventMap = {
	"did-navigate": { url: string };
	"did-navigate-in-page": { url: string; isMainFrame: boolean };
	"did-start-loading": Record<string, never>;
	"did-stop-loading": Record<string, never>;
	"did-fail-load": { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
	"page-title-updated": { title: string };
};

export function ElectronWebviewHost({
	initialUrl,
	initialDevice,
	className,
	onApiChange,
	onEvent,
}: BrowserHostSurfaceProps) {
	const webviewRef = useRef<ElectronWebviewElement | null>(null);
	// 每个新 guest 单独捕获默认 UA；不跨 guest 缓存（不同 guest 默认 UA 可能不同）。
	const defaultUserAgentRef = useRef<string | null>(null);
	// onEvent/onApiChange 走 ref，保证 raw listener 只注册一次，不随 render 重建。
	const onEventRef = useRef(onEvent);
	useEffect(() => {
		onEventRef.current = onEvent;
	}, [onEvent]);
	const onApiChangeRef = useRef(onApiChange);
	useEffect(() => {
		onApiChangeRef.current = onApiChange;
	}, [onApiChange]);

	// initialUrl 只在 mount 时读取一次：BrowserPanel 切 tab 已显式 host.loadUrl(...)，
	// 若 initialUrl 变化再触发 loadURL 会造成重复导航 → ERR_ABORTED / progress 闪烁。
	const mountInitialUrlRef = useRef(initialUrl);
	const initialDeviceRef = useRef(initialDevice);

	const applyDeviceProfile = useCallback((profile: BrowserDeviceProfile): void => {
		const webview = webviewRef.current;
		if (!webview) return;
		// 首次拿到 guest 时捕获真实默认 UA，PC 档恢复它（不是写死某个 Chrome UA）。
		if (defaultUserAgentRef.current == null) {
			try {
				defaultUserAgentRef.current = webview.getUserAgent();
			} catch {
				defaultUserAgentRef.current = null;
			}
		}
		const userAgent = deviceUserAgent(profile);
		if (userAgent) {
			webview.setUserAgent(userAgent);
		} else if (defaultUserAgentRef.current) {
			webview.setUserAgent(defaultUserAgentRef.current);
		}
	}, []);

	const buildHostApi = useCallback((): BrowserHostApi => {
		return {
			async loadUrl(url: string): Promise<void> {
				const webview = webviewRef.current;
				if (!webview) return;
				try {
					await webview.loadURL(url);
				} catch (error) {
					// 快速连续导航时旧请求以 ERR_ABORTED reject，属正常导航替换，不上抛。
					if (!isExpectedNavigationAbort(error)) throw error;
				}
			},
			goBack() {
				webviewRef.current?.goBack();
			},
			goForward() {
				webviewRef.current?.goForward();
			},
			reload() {
				webviewRef.current?.reload();
			},
			setDeviceProfile(profile: BrowserDeviceProfile) {
				applyDeviceProfile(profile);
			},
		};
	}, [applyDeviceProfile]);

	// 稳定 ref 回调 + 稳定 api 实例：device/className 等 prop 变化不触发 ref 重挂，
	// 也不会让 BrowserPanel.hostRef 每次拿到新对象。
	const hostApiRef = useRef<BrowserHostApi | null>(null);
	const handleWebviewRef = useCallback(
		(el: ElectronWebviewElement | null) => {
			// 卸载旧 guest：先移除全部 listener 再清引用，防止重复挂载叠加监听。
			const previous = webviewRef.current;
			if (previous && previous !== el && detachListenersRef.current) {
				detachListenersRef.current(previous);
			}
			webviewRef.current = el;
			if (el) {
				// 保持与迁移前一致：renderer 侧声明属性，主进程 will-attach-webview 仍会清理。
				el.setAttribute("allowfileaccess", "true");
				// 新 guest：重置默认 UA 捕获，确保 PC 档恢复的是本 guest 的真实默认 UA。
				defaultUserAgentRef.current = null;
				applyDeviceProfile(initialDeviceRef.current);
				hostApiRef.current = buildHostApi();
				onApiChangeRef.current?.(hostApiRef.current);
			} else {
				hostApiRef.current = null;
				onApiChangeRef.current?.(null);
			}
		},
		[applyDeviceProfile, buildHostApi],
	);

	const detachListenersRef = useRef<((webview: ElectronWebviewElement) => void) | null>(null);

	// raw listener 注册只依赖 webview element identity；事件 → neutral event 转换在此完成。
	useEffect(() => {
		const webview = webviewRef.current;
		if (!webview) return;

		const emit = (event: BrowserHostEvent) => {
			onEventRef.current?.(event);
		};
		const listener = <K extends keyof ElectronWebviewEventMap>(
			handler: (payload: ElectronWebviewEventMap[K]) => void,
		) => {
			return (raw: Event) => {
				handler(raw as unknown as ElectronWebviewEventMap[K]);
			};
		};

		const onDidNavigate = listener<"did-navigate">((evt) => {
			emit({
				type: "navigated",
				url: evt.url,
				canGoBack: webview.canGoBack(),
				canGoForward: webview.canGoForward(),
			});
		});
		const onDidNavigateInPage = listener<"did-navigate-in-page">((evt) => {
			// 只有主 frame 的 in-page 导航（#anchor / pushState）才允许改地址栏，
			// iframe hash/history 会污染顶层地址。
			if (!evt.isMainFrame) return;
			emit({
				type: "navigated",
				url: evt.url,
				canGoBack: webview.canGoBack(),
				canGoForward: webview.canGoForward(),
			});
		});
		const onDidStartLoading = listener<"did-start-loading">(() => {
			emit({ type: "loading-started" });
		});
		const onDidStopLoading = listener<"did-stop-loading">(() => {
			emit({
				type: "loading-stopped",
				canGoBack: webview.canGoBack(),
				canGoForward: webview.canGoForward(),
			});
		});
		const onDidFailLoad = listener<"did-fail-load">((evt) => {
			// 非 main frame 失败与顶层导航状态无关，忽略。
			if (!evt.isMainFrame) return;
			// 被新导航替换（ERR_ABORTED / -3）不是产品层的「加载失败」，在边界吸收，
			// 不向 BrowserPanel 下发 —— 否则快速连续导航时 loading 态被旧请求提前清掉。
			if (evt.errorCode === -3) return;
			emit({
				type: "load-failed",
				kind: "failed",
				errorCode: evt.errorCode,
				errorDescription: evt.errorDescription,
			});
		});
		const onPageTitleUpdated = listener<"page-title-updated">((evt) => {
			// 只有真实非空 title 才下发，防止 tab 标题被空串/空白来回闪烁覆盖。
			const title = evt.title?.trim();
			if (!title) return;
			emit({ type: "title-updated", title });
		});

		// 注：Electron <webview> 的 new-window 事件已在 Electron 22 移除（本仓 Electron 43），
		// target="_blank"/window.open 由主进程 guest setWindowOpenHandler 统一接管
		//（browserPanelWebviewHost.ts），不再有渲染层事件可听。

		const rawListeners: Array<[string, (event: Event) => void]> = [
			["did-navigate", onDidNavigate],
			["did-navigate-in-page", onDidNavigateInPage],
			["did-start-loading", onDidStartLoading],
			["did-stop-loading", onDidStopLoading],
			["did-fail-load", onDidFailLoad],
			["page-title-updated", onPageTitleUpdated],
		];
		for (const [name, handler] of rawListeners) {
			webview.addEventListener(name, handler);
		}

		detachListenersRef.current = (target: ElectronWebviewElement) => {
			for (const [name, handler] of rawListeners) {
				target.removeEventListener(name, handler);
			}
		};

		return () => {
			for (const [name, handler] of rawListeners) {
				webview.removeEventListener(name, handler);
			}
			detachListenersRef.current = null;
			// unmount 时必须通知 BrowserPanel 宿主已失效，而不是只清 webviewRef。
			onApiChangeRef.current?.(null);
		};
	}, []);

	return (
		<webview
			ref={handleWebviewRef as unknown as React.Ref<HTMLDivElement>}
			className={className ?? "browser-webview"}
			src={mountInitialUrlRef.current}
		/>
	);
}
