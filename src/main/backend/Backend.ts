import type { AppFocusSessionTarget, AppSettings } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import type { RpcRouter } from "../transport/RpcRouter";
import type { PlatformServices } from "../platform/PlatformServices";
import type { MainWindowControls } from "../window/MainWindowControlsContract";
import type { ExternalFileCapabilityStore } from "../fs/ExternalFileCapabilityStore";

export interface BackendHost {
	mainWindowControls: MainWindowControls;
	sendToRenderer(channel: string, ...args: unknown[]): void;
	hasLiveWindow(): boolean;
	openExternalUrl(url: string, forceSystem?: boolean): Promise<void>;
	refreshTrayContextMenu(): void;
	peekPendingFocusTarget(): AppFocusSessionTarget | null;
	acknowledgeFocusTarget(id: string): void;
	focusSessionFromNotification(sessionId?: string): boolean;
	restartApplication: () => void;
}

export interface CreateBackendOptions {
	router: RpcRouter;
	platform: PlatformServices;
	host: BackendHost;
	runtime?: {
		devRendererUrl?: string;
	};
	externalFileCapabilities?: Pick<ExternalFileCapabilityStore, "consumeCopy" | "consumeRead">;
}

export interface Backend {
	readonly appLogger: AppLogger;
	readonly settingsStore: SettingsStore;
	readonly mainCopy: (
		key: MainProcessTranslationKey,
		params?: Record<string, string | number>,
	) => string;
	resolveSessionIdForAgent(agentId: string): string | undefined;
	hasActiveStreaming(): boolean;
	startAfterWindowCreated(): void;
	dispose(): Promise<void>;
}
