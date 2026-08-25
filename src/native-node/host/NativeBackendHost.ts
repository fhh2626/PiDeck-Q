import { ipcChannels } from "../../shared/ipc";
import type { HostBridge } from "./HostBridge";
import { NativeMainWindowControls } from "./NativeMainWindowControls";
import type { BackendHost } from "../../main/backend/Backend";
import { openExternalLink } from "../../main/browser/externalLinks";
import type { NativeRendererServer } from "../transport/NativeRendererServer";
import type { AppLogger } from "../../main/logging/AppLogger";

export type NativeTrayLabels = {
	showWindow: string;
	restart: string;
	quit: string;
};

/** BackendHost adapter: routes only host/renderer lifecycle operations to Qt/HTTP. */
export class NativeBackendHost implements BackendHost {
	readonly mainWindowControls: NativeMainWindowControls;
	private pendingFocusTarget: { sessionId: string } | null = null;
	private liveWindow = false;
	private windowVisible = false;
	private logger?: Pick<AppLogger, "warn">;

	constructor(
		private readonly host: HostBridge,
		private readonly rendererServer: NativeRendererServer,
		private readonly getTrayLabels: () => NativeTrayLabels,
		logger?: Pick<AppLogger, "warn">,
	) {
		this.logger = logger;
		this.mainWindowControls = new NativeMainWindowControls(
			host,
			(channel, ...args) => this.sendToRenderer(channel, ...args),
		);
		host.on<{ sessionId?: string }>("application.focusTarget", (payload) => {
			if (payload?.sessionId) this.pendingFocusTarget = { sessionId: payload.sessionId };
		});
	}

	setLogger(logger: Pick<AppLogger, "warn">): void {
		this.logger = logger;
	}

	markWindowCreated(): void {
		this.liveWindow = true;
		this.windowVisible = true;
		this.mainWindowControls.markCreated();
	}

	markWindowDestroyed(): void {
		this.liveWindow = false;
		this.windowVisible = false;
		this.mainWindowControls.markDestroyed();
	}

	markWindowVisible(visible: boolean): void {
		this.windowVisible = visible;
	}

	// Backend registration passes this callback across domain boundaries; keep the receiver
	// bound so delayed catalog scans can still broadcast through the Native renderer server.
	sendToRenderer = (channel: string, ...args: unknown[]): void => {
		this.rendererServer.broadcast(channel, args);
	};

	hasLiveWindow(): boolean {
		return this.liveWindow;
	}

	/** Hidden-to-tray pages may have Chromium timers throttled for minutes. */
	shouldWatchRendererHeartbeat(): boolean {
		return this.liveWindow && this.windowVisible && !this.mainWindowControls.isMinimized();
	}

	async openExternalUrl(url: string, _forceSystem = false): Promise<void> {
		await openExternalLink(url, {
			openInSystem: (target) => this.host.request("shell.openExternal", { url: target }),
			logger: this.logger,
		});
	}

	refreshTrayContextMenu(): void {
		const labels = this.getTrayLabels();
		void this.host.request("tray.update", labels).catch(() => undefined);
	}

	peekPendingFocusTarget(): { sessionId: string } | null {
		return this.pendingFocusTarget;
	}

	takePendingFocusTarget(): { sessionId: string } | null {
		const target = this.pendingFocusTarget;
		this.pendingFocusTarget = null;
		return target;
	}

	focusSessionFromNotification(sessionId?: string): boolean {
		void this.host.request("window.show").catch(() => undefined);
		void this.host.request("window.focus").catch(() => undefined);
		if (sessionId) {
			// Keep a pull-safe copy even when the window is already marked live:
			// EventSource may still be connecting when a notification arrives.
			this.pendingFocusTarget = { sessionId };
			if (this.liveWindow) this.sendToRenderer(ipcChannels.appFocusSessionTarget, { sessionId });
		}
		return this.liveWindow;
	}

	restartApplication = (): void => {
		void this.host.request("application.restart").catch(() => undefined);
	};

	/** Called by the Qt host after the first window is visible. */
	onWindowReady(): void {
		this.markWindowCreated();
		// SSE delivery is best-effort. Never consume pending state here: window.ready
		// can arrive before EventSource connects, and the renderer's pull RPC is the
		// reliable take-and-clear path.
		const target = this.peekPendingFocusTarget();
		if (target) this.sendToRenderer(ipcChannels.appFocusSessionTarget, target);
	}
}
