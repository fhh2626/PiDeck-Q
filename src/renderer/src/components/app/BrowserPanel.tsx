import { useCallback, useEffect, useRef, useState } from "react";
import {
	ArrowLeft,
	ArrowRight,
	Home,
	Maximize2,
	Minus,
	Plus,
	RefreshCw,
	Smartphone,
	Tablet,
	X,
} from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import type {
	BrowserDeviceProfile,
	BrowserHostApi,
	BrowserHostEvent,
	BrowserHostSurface,
} from "../../browser/BrowserHostApi";
import {
	createBrowserTabInSession,
	DEFAULT_HOME,
	ensureInitialBrowserTab,
	getBrowserPanelSessionSnapshot,
	resetBrowserPanelSession,
	subscribeBrowserNavigation,
	updateBrowserPanelSession,
	type BrowserTab,
} from "../../browser/BrowserPanelSession";

// Button 收口状态（P0）：工具栏/导航/UA 菜单按钮已换 shadcn Button（ghost/outline + 原尺寸 class 保留）。
// 保留原生：.browser-tab-close（16px 微型关闭钮，Button 最小档 icon-xs 24px 无法替代）。

interface DevicePreset {
	id: BrowserDeviceProfile;
	label: string;
}

const DEVICE_PRESETS: DevicePreset[] = [
	{ id: "pc", label: "browser.devicePC" },
	{ id: "mobile", label: "browser.deviceMobile" },
	{ id: "tablet", label: "browser.deviceTablet" },
];

export function BrowserPanel(props: {
	isFullscreen?: boolean;
	onClose?: () => void;
	onToggleFullscreen?: () => void;
	/** 最小化：关闭全屏弹框，回到抽屉模式。 */
	onMinimize?: () => void;
	/** 嵌入右侧统一 Tab 栏时隐藏关闭按钮，避免与 drawer-chrome 重复 */
	hideChromeClose?: boolean;
	/** 宿主 adapter 由 composition root（BrowserSurface）注入，BrowserPanel 不固定 Electron。 */
	hostSurface: BrowserHostSurface;
}) {
	const { onClose, onMinimize, onToggleFullscreen } = props;
	const [initialTab] = useState(() => ensureInitialBrowserTab());
	const hostRef = useRef<BrowserHostApi | null>(null);
	const [tabs, setTabs] = useState<BrowserTab[]>(() => [...getBrowserPanelSessionSnapshot().tabs]);
	const [activeTabId, setActiveTabId] = useState<string | null>(
		() => getBrowserPanelSessionSnapshot().activeTabId,
	);
	const [url, setUrl] = useState(initialTab.url);
	const [inputValue, setInputValue] = useState(initialTab.url);
	const [canGoBack, setCanGoBack] = useState(false);
	const [canGoForward, setCanGoForward] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [device, setDevice] = useState<BrowserDeviceProfile>(() => getBrowserPanelSessionSnapshot().device);
	const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
	const deviceMenuRef = useRef<HTMLDivElement | null>(null);

	const persistTabs = useCallback((nextTabs: BrowserTab[], nextActiveId: string | null) => {
		updateBrowserPanelSession({ tabs: nextTabs, activeTabId: nextActiveId });
		setTabs([...nextTabs]);
		setActiveTabId(nextActiveId);
	}, []);

	const updateActiveTab = useCallback(
		(patch: Partial<BrowserTab>) => {
			if (!getBrowserPanelSessionSnapshot().activeTabId) return;
			const activeId = getBrowserPanelSessionSnapshot().activeTabId;
			const nextTabs = getBrowserPanelSessionSnapshot().tabs.map((tab) =>
				tab.id === activeId ? { ...tab, ...patch } : tab,
			);
			updateBrowserPanelSession({ tabs: nextTabs });
			setTabs([...nextTabs]);
		},
		[],
	);

	const loadUrl = useCallback(
		async (targetUrl: string, deviceOverride?: BrowserDeviceProfile) => {
			const host = hostRef.current;
			if (!host) return;

			// 导航意图立即反映到地址栏与 url state（重构前 loadUrl 的不变量）：
			// 若等宿主导航确认事件才回填，「加载中」窗口期内 selectDevice 会读到旧 url，
			// 把刚发起的导航打回旧页面（慢网络下窗口更长）。所有导航入口经此函数自动安全。
			setUrl(targetUrl);
			setInputValue(targetUrl);

			setIsLoading(true);

			host.setDeviceProfile(deviceOverride ?? device);

			try {
				await host.loadUrl(targetUrl);
			} catch (error) {
				console.warn("Browser navigation failed", error);
				setIsLoading(false);
			}
		},
		[device],
	);

	const navigate = useCallback(
		(targetUrl?: string) => {
			let finalUrl = targetUrl ?? inputValue.trim();
			if (!finalUrl) return;
			if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(finalUrl)) {
				finalUrl = `https://${finalUrl}`;
			}
			void loadUrl(finalUrl);
		},
		[inputValue, loadUrl],
	);

	const switchTab = useCallback(
		(tabId: string) => {
			if (getBrowserPanelSessionSnapshot().activeTabId === tabId) return;
			const tab = getBrowserPanelSessionSnapshot().tabs.find((item) => item.id === tabId);
			if (!tab) return;
			updateBrowserPanelSession({ activeTabId: tabId });
			setActiveTabId(tabId);
			void loadUrl(tab.url);
		},
		[loadUrl],
	);

	const addTab = useCallback(() => {
		const newTab = createBrowserTabInSession(DEFAULT_HOME, t("browser.newTab"));
		persistTabs([...getBrowserPanelSessionSnapshot().tabs], newTab.id);
		void loadUrl(DEFAULT_HOME);
	}, [loadUrl, persistTabs]);

	/**
	 * 统一接收 adapter 的 neutral 事件；产品策略（地址栏/tab/popup 分发）都在这里，
	 * Electron 事件 shape 与错误格式不进入本组件。
	 */
	const handleHostEvent = useCallback(
		(event: BrowserHostEvent) => {
			switch (event.type) {
				case "navigated": {
					setUrl(event.url);
					setInputValue(event.url);
					setCanGoBack(event.canGoBack);
					setCanGoForward(event.canGoForward);
					// 只更新 URL；title 由 title-updated 更新，避免标题闪烁。
					updateActiveTab({ url: event.url });
					break;
				}
				case "loading-started": {
					setIsLoading(true);
					break;
				}
				case "loading-stopped": {
					setIsLoading(false);
					setCanGoBack(event.canGoBack);
					setCanGoForward(event.canGoForward);
					break;
				}
				case "load-failed": {
					// 无论 aborted/failed 都确保 loading 态复位；不新增 error page/modal/toast。
					setIsLoading(false);
					break;
				}
				case "title-updated": {
					// 只在真实 page title 到达时才替换 tab 标题（adapter 已过滤空值）。
					updateActiveTab({ title: event.title });
					break;
				}
			}
		},
		[updateActiveTab],
	);

	// 订阅外部导航请求：当外部（如 App.tsx / IPC）调用 requestBrowserNavigation 时，
	// 直接收到通知并实时加载新 tab，替代原 50ms 轮询方案。导航统一经 loadUrl()
	// 中心入口（地址栏/isLoading/device/错误处理自动一致），本回调只同步 tab 列表。
	useEffect(() => {
		const unsubscribe = subscribeBrowserNavigation((tab) => {
			if (!hostRef.current) return;
			const snapshot = getBrowserPanelSessionSnapshot();
			setTabs([...snapshot.tabs]);
			setActiveTabId(tab.id);
			void loadUrl(tab.url, snapshot.device);
		});
		return unsubscribe;
	}, [loadUrl]);

	const closeTab = useCallback(
		(tabId: string, event: React.MouseEvent) => {
			event.stopPropagation();
			const current = getBrowserPanelSessionSnapshot().tabs;
			if (current.length <= 1) {
				// 关闭最后一个 tab：清空 session 与本地 tabs 状态，避免旧 tab 残留显示
				// （onClose 触发的 state 更新可能是同值 no-op，React 会跳过重渲染，必须显式同步）。
				// onClose 语义 = 关闭整个浏览器面板：抽屉模式收起侧边栏，全屏模式退出全屏并收起侧边栏。
				resetBrowserPanelSession();
				setTabs([]);
				setActiveTabId(null);
				onClose?.();
				return;
			}
			const currentActiveId = getBrowserPanelSessionSnapshot().activeTabId;
			const wasActive = currentActiveId === tabId;
			const index = current.findIndex((tab) => tab.id === tabId);
			const nextTabs = current.filter((tab) => tab.id !== tabId);
			let nextActiveId = currentActiveId;
			if (wasActive) {
				nextActiveId = nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null;
			}
			persistTabs(nextTabs, nextActiveId);
			if (wasActive) {
				const nextTab = nextTabs.find((tab) => tab.id === nextActiveId);
				if (nextTab) void loadUrl(nextTab.url);
			}
		},
		[loadUrl, onClose, persistTabs],
	);

	const selectDevice = useCallback(
		(nextDevice: BrowserDeviceProfile) => {
			updateBrowserPanelSession({ device: nextDevice });
			setDevice(nextDevice);
			setDeviceMenuOpen(false);
			// 仅改 UA 不会触发布局变化；同时切换 browser-panel 的 device class 限制 webview 视口宽度。
			// loadUrl 内部先 setDeviceProfile 再导航，保持「切设备会 reload 页面」的现有行为。
			void loadUrl(url || DEFAULT_HOME, nextDevice);
		},
		[loadUrl, url],
	);

	useEffect(() => {
		if (!deviceMenuOpen) return;
		const handleMouseDown = (event: MouseEvent) => {
			if (!deviceMenuRef.current?.contains(event.target as Node)) {
				setDeviceMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [deviceMenuOpen]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			navigate();
		},
		[navigate],
	);

	const HostSurface = props.hostSurface;
	const panelClass = `browser-panel${props.isFullscreen ? " is-fullscreen" : ""} device-${device}`;
	const activeDevicePreset = DEVICE_PRESETS.find((preset) => preset.id === device) ?? DEVICE_PRESETS[0];
	const deviceIcon = device === "mobile" ? <Smartphone size={13} /> : device === "tablet" ? <Tablet size={13} /> : null;

	return (
		<div className={panelClass} onClick={(event) => event.stopPropagation()}>
			<div className="flex shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-border/40 bg-bg-subtle [scrollbar-width:thin]">
				{tabs.map((tab) => (
					<div
						key={tab.id}
						className={`flex max-w-[180px] shrink-0 cursor-pointer items-center gap-1 border-r border-border/30 px-2.5 py-1 text-xs whitespace-nowrap select-none text-text-tertiary${tab.id === activeTabId ? " border-b-2 border-[var(--color-accent)] -mb-px bg-bg-panel text-text-primary" : ""}`}
						onClick={() => switchTab(tab.id)}
					>
						<span className="min-w-0 truncate">{tab.title || tab.url}</span>
						<Button variant="ghost" size="icon-sm" className="browser-tab-close" onClick={(event) => closeTab(tab.id, event)} title={t("browser.closeTab")}>
							<X size={11} />
						</Button>
					</div>
				))}
<Button variant="ghost" size="icon-sm" className="size-[30px] text-text-tertiary hover:text-[color:var(--color-accent)]" onClick={addTab} title={t("browser.newTab")}>
					<Plus size={14} />
				</Button>
				{!props.isFullscreen && (
					<div className="ml-auto flex shrink-0 items-center gap-0.5 pr-1">
<Button variant="ghost" size="icon-sm" className="size-[26px] rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary" onClick={onToggleFullscreen} title={t("browser.fullscreen")}>
							<Maximize2 size={13} />
						</Button>
						{/* 统一 drawer chrome 已提供关闭；此处仅在独立/旧布局时保留 */}
						{!props.hideChromeClose && (
<Button variant="ghost" size="icon-sm" className="size-[26px] rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary" onClick={onClose} title={t("common.close")}>
								<X size={14} />
							</Button>
						)}
					</div>
				)}
			</div>

			<div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5">
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" disabled={!canGoBack} onClick={() => hostRef.current?.goBack()} title={t("browser.back")}>
					<ArrowLeft size={15} />
				</Button>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" disabled={!canGoForward} onClick={() => hostRef.current?.goForward()} title={t("browser.forward")}>
					<ArrowRight size={15} />
				</Button>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" onClick={() => hostRef.current?.reload()} title={t("browser.reload")}>
					<RefreshCw size={15} />
				</Button>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" onClick={() => void loadUrl(DEFAULT_HOME)} title={t("browser.home")}>
					<Home size={15} />
				</Button>
				<div className="min-w-0 flex-1">
					<Input
						type="text"
						className="h-[30px] w-full rounded-md border border-border-subtle bg-bg-input px-2.5 text-[13px] text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
						value={inputValue}
						onChange={(event) => setInputValue(event.target.value)}
						onKeyDown={handleKeyDown}
						onFocus={(event) => event.target.select()}
						placeholder={t("browser.urlPlaceholder")}
					/>
				</div>
				<div className="relative flex shrink-0 items-center text-text-tertiary" ref={deviceMenuRef}>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className={`h-7 min-w-[68px] gap-1 border border-border-subtle bg-bg-panel px-2 text-xs text-text-secondary outline-none focus-visible:shadow-[var(--focus-ring)]${deviceMenuOpen ? " border-[var(--color-accent)] bg-bg-hover text-[color:var(--color-accent)]" : ""} hover:border-[var(--color-accent)] hover:bg-bg-hover hover:text-[color:var(--color-accent)]`}
						onClick={() => setDeviceMenuOpen((open) => !open)}
						title={t("browser.deviceLabel")}
					>
						{deviceIcon}
						<span>{t(activeDevicePreset.label as any)}</span>
					</Button>
					{deviceMenuOpen && (
						<div className="absolute top-[calc(100%+6px)] right-0 z-30 min-w-[112px] rounded-md border border-border-subtle bg-bg-panel p-1 shadow-[var(--shadow-popover)]">
							{DEVICE_PRESETS.map((preset) => (
								<Button
									key={preset.id}
									type="button"
									variant="ghost"
									size="sm"
									className={`h-[30px] w-full items-center gap-[7px] rounded-sm px-2 text-xs text-text-secondary text-left${preset.id === device ? " bg-bg-active text-[color:var(--color-accent)]" : ""} hover:bg-bg-hover hover:text-[color:var(--color-accent)]`}
									onClick={() => selectDevice(preset.id)}
								>
									{preset.id === "mobile" ? <Smartphone size={13} /> : preset.id === "tablet" ? <Tablet size={13} /> : <span className="size-[13px] rounded-[3px] border border-current" />}
									<span>{t(preset.label as any)}</span>
								</Button>
							))}
						</div>
					)}
				</div>
				{props.isFullscreen ? (
					<>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" onClick={onMinimize} title={t("browser.minimize")}>
							<Minus size={15} />
						</Button>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" onClick={onClose} title={t("browser.close")}>
							<X size={15} />
						</Button>
					</>
				) : null}
			</div>

			{isLoading && (
				// 宿主无渐进进度事件（webview 标签无 load-progress），只做不确定动画。
				<div className="h-0.5 shrink-0 overflow-hidden bg-bg-subtle">
					<div className="h-full w-1/3 animate-[browser-load-slide_1s_ease-in-out_infinite] bg-[var(--color-accent)] rounded-full" />
				</div>
			)}

			<div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-bg-subtle">
				<HostSurface
					initialUrl={initialTab.url}
					initialDevice={device}
					className="browser-webview"
					onApiChange={(api) => {
						hostRef.current = api;
					}}
					onEvent={handleHostEvent}
				/>
			</div>
		</div>
	);
}
