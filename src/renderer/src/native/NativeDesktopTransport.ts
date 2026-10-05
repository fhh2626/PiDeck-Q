import type { DesktopRpcTransport } from "@shared/desktop/DesktopRpcTransport";
import { MAX_NATIVE_RPC_BODY_BYTES } from "@shared/desktop/nativeLimits";
import { ipcChannels } from "../../../shared/ipc";

const NATIVE_HEARTBEAT_CATCHUP_DELAY_MS = 400;
/**
 * 事件游标在此时间内仍有推进，说明 SSE 正在消化积压（例如一个 MB 级全量帧），
 * 此时重连只会丢掉进行中的帧并触发新的全量补发，所以继续等待而不是重连。
 */
const NATIVE_EVENT_PROGRESS_GRACE_MS = 5_000;
const NATIVE_EVENT_CHANNEL_READY_TIMEOUT_MS = 8_000;
/** 连续这么多次建立 SSE 都没等到 eventChannelReady，即判定事件通道不健康并上报。 */
const NATIVE_EVENT_CHANNEL_UNHEALTHY_AFTER_ATTEMPTS = 3;
/** EventSource 进入 CLOSED（不再自动重试）后的手动重连退避。 */
const NATIVE_EVENT_RECONNECT_BASE_DELAY_MS = 1_000;
const NATIVE_EVENT_RECONNECT_MAX_DELAY_MS = 30_000;
/** EventSource.CLOSED；用字面量避免依赖运行环境上的静态常量。 */
const EVENT_SOURCE_CLOSED = 2;
const NATIVE_READ_RPC_TIMEOUT_MS = 60_000;
export const NATIVE_CLIPBOARD_SNAPSHOT_TIMEOUT_MS = 5_000;
const NATIVE_READONLY_RPC_CHANNELS: ReadonlySet<string> = new Set([
	ipcChannels.projectsList,
	ipcChannels.sessionsCatalogList,
	ipcChannels.sessionsCatalogListArchived,
	ipcChannels.sessionsCatalogReadMessages,
	ipcChannels.sessionsCatalogReadMessagePage,
	ipcChannels.sessionsCatalogReadProcessEvents,
	ipcChannels.sessionsCatalogReadReferenceMessages,
	ipcChannels.sessionsCatalogGetContextControllerState,
	ipcChannels.sessionsCatalogReadMessageFullText,
	ipcChannels.filesList,
	ipcChannels.filesReadContent,
	ipcChannels.filesReadBase64,
	ipcChannels.filesReadBase64External,
	ipcChannels.nativeClipboardSnapshot,
]);

export function nativeRpcTimeoutMs(channel: string): number | undefined {
	// Clipboard paste has already cancelled the browser default action, so it
	// gets a short deadline and can still use the event's image fallback. Other
	// idempotent reads keep the longer deadline; mutations remain unbounded so a
	// local abort cannot report an ambiguous mutation as an ordinary failure.
	if (channel === ipcChannels.nativeClipboardSnapshot) return NATIVE_CLIPBOARD_SNAPSHOT_TIMEOUT_MS;
	return NATIVE_READONLY_RPC_CHANNELS.has(channel)
		? NATIVE_READ_RPC_TIMEOUT_MS
		: undefined;
}

interface NativeRpcResponse<T> {
	ok: boolean;
	result?: T;
	error?: { message?: string };
}

interface NativeEventFrame {
	channel: string;
	args: unknown[];
}

export interface NativeHeartbeatState {
	eventSeq?: number;
	eventSourceGeneration?: string;
}

interface NativeEventChannelReady {
	eventSeq?: number;
	eventSourceGeneration?: string;
}

type QueuedEvent = {
	seq: number;
	frame: NativeEventFrame;
};

type NativeDesktopTransportOptions = {
	onResyncRequired?: (payload: unknown) => void;
	/** Bootstrap supplies the snapshot boundary before the first SSE connection. */
	initialEventSeq?: number;
	/** Test override; production uses the bounded 8 second startup deadline. */
	readyTimeoutMs?: number;
	/**
	 * 事件通道健康度变化：连续多次连接都未就绪时报 false，之后首次就绪时报 true。
	 * 只在状态翻转时回调，不会重复上报。
	 */
	onEventChannelHealthChange?: (healthy: boolean, info: { failedAttempts: number }) => void;
};

function isNativeEventFrame(value: unknown): value is NativeEventFrame {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return "channel" in value && typeof value.channel === "string"
		&& "args" in value && Array.isArray(value.args);
}

function nativeEventChannelReady(value: unknown): NativeEventChannelReady {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return {
		eventSeq: "eventSeq" in value && typeof value.eventSeq === "number" ? value.eventSeq : undefined,
		eventSourceGeneration:
			"eventSourceGeneration" in value && typeof value.eventSourceGeneration === "string"
				? value.eventSourceGeneration
				: undefined,
	};
}

/** HTTP + replayable SSE transport used by the React page hosted by the native sidecar. */
export class NativeDesktopTransport implements DesktopRpcTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	private eventSource: EventSource | null = null;
	private readonly readyPromise: Promise<void>;
	private resolveReady!: () => void;
	private rejectReady!: (error: Error) => void;
	private readySettled = false;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;
	private eventSourceErrored = false;
	private readonly queuedEvents: QueuedEvent[] = [];
	private activated = false;
	private disposed = false;
	private lastEventSeq = 0;
	private eventSourceGeneration = "";
	private hasEventCursor = false;
	private heartbeatRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatRecoveryExpectedSeq: number | null = null;
	/** 事件游标最近一次向前推进的时间（毫秒时间戳）；0 表示尚未收到过事件。 */
	private lastEventProgressAt = 0;
	/** 自上次 eventChannelReady 以来建立过的 SSE 连接次数（含当前这一次）。 */
	private connectAttemptsSinceReady = 0;
	private eventChannelReportedUnhealthy = false;
	private closedReconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly options: NativeDesktopTransportOptions = {},
	) {
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.readyTimer = setTimeout(() => {
			if (this.readySettled) return;
			this.readySettled = true;
			this.readyTimer = null;
			this.eventSource?.close();
			this.eventSource = null;
			this.rejectReady(new Error(
				this.eventSourceErrored
					? "Native event channel failed before becoming ready"
					: "Native event channel timed out before becoming ready",
			));
		}, options.readyTimeoutMs ?? NATIVE_EVENT_CHANNEL_READY_TIMEOUT_MS);
		if (options.initialEventSeq !== undefined) {
			this.lastEventSeq = options.initialEventSeq;
			this.hasEventCursor = true;
		}
		this.connectEventSource();
	}

	private connectEventSource(): void {
		if (this.disposed) return;
		const eventsUrl = new URL("/__pideck/events", this.baseUrl);
		eventsUrl.searchParams.set("token", this.token);
		// EventSource only carries Last-Event-ID automatically when it reconnects
		// itself. Manual reconstruction must send the cursor explicitly or replay
		// starts from the live tail and silently skips the gap.
		if (this.hasEventCursor) eventsUrl.searchParams.set("lastEventId", String(this.lastEventSeq));
		this.cancelClosedReconnect();
		this.connectAttemptsSinceReady += 1;
		if (
			this.connectAttemptsSinceReady >= NATIVE_EVENT_CHANNEL_UNHEALTHY_AFTER_ATTEMPTS &&
			!this.eventChannelReportedUnhealthy
		) {
			// 只在“确实连不上”时上报：单次断线由 EventSource 自动重试或心跳重连即可恢复，
			// 连续多次仍未就绪说明页面虽可交互但实时更新已停止，必须让用户和日志看见。
			this.eventChannelReportedUnhealthy = true;
			this.options.onEventChannelHealthChange?.(false, {
				failedAttempts: this.connectAttemptsSinceReady - 1,
			});
		}
		const eventSource = new EventSource(eventsUrl);
		this.eventSource = eventSource;
		eventSource.onmessage = (event) => this.handleEvent(event);
		eventSource.onerror = () => {
			// EventSource performs its own retry. Record the failure so the bounded
			// startup deadline rejects with a diagnostic instead of hanging forever.
			if (!this.readySettled) this.eventSourceErrored = true;
			// 非 200 响应等致命错误会让 EventSource 进入 CLOSED 且不再自动重试；
			// 空闲时心跳也看不出序号落后，没人会重连，所以这里按退避自行重连。
			if (eventSource.readyState === EVENT_SOURCE_CLOSED && this.eventSource === eventSource) {
				this.scheduleClosedReconnect();
			}
		};
	}

	private scheduleClosedReconnect(): void {
		if (this.disposed || this.closedReconnectTimer !== null) return;
		const exponent = Math.max(0, this.connectAttemptsSinceReady - 1);
		const delayMs = Math.min(
			NATIVE_EVENT_RECONNECT_BASE_DELAY_MS * 2 ** exponent,
			NATIVE_EVENT_RECONNECT_MAX_DELAY_MS,
		);
		this.closedReconnectTimer = setTimeout(() => {
			this.closedReconnectTimer = null;
			this.reconnect();
		}, delayMs);
	}

	private cancelClosedReconnect(): void {
		if (this.closedReconnectTimer !== null) clearTimeout(this.closedReconnectTimer);
		this.closedReconnectTimer = null;
	}

	private markEventChannelReady(): void {
		this.connectAttemptsSinceReady = 0;
		if (!this.eventChannelReportedUnhealthy) return;
		this.eventChannelReportedUnhealthy = false;
		this.options.onEventChannelHealthChange?.(true, { failedAttempts: 0 });
	}

	private handleEvent(event: MessageEvent<string>): void {
		const parsedSeq = Number(event.lastEventId);
		const seq = Number.isInteger(parsedSeq) && parsedSeq >= 0 ? parsedSeq : this.lastEventSeq;
		let parsed: unknown;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!isNativeEventFrame(parsed)) return;
		const frame = parsed;
		if (frame.channel === "native.eventChannelReady") {
			const payload = nativeEventChannelReady(frame.args[0]);
			if (typeof payload.eventSourceGeneration === "string") this.eventSourceGeneration = payload.eventSourceGeneration;
			const readySeq = typeof payload.eventSeq === "number" ? Math.max(seq, payload.eventSeq) : seq;
			this.commitEventSeq(readySeq);
			this.markEventChannelReady();
			this.settleReady();
			return;
		}
		if (!this.activated) this.queuedEvents.push({ seq, frame });
		else this.dispatch(frame);
		this.commitEventSeq(seq);
	}

	private commitEventSeq(seq: number): void {
		this.hasEventCursor = true;
		if (seq > this.lastEventSeq) this.lastEventProgressAt = Date.now();
		this.lastEventSeq = Math.max(this.lastEventSeq, seq);
		if (
			this.heartbeatRecoveryExpectedSeq !== null &&
			this.lastEventSeq >= this.heartbeatRecoveryExpectedSeq
		) {
			this.cancelHeartbeatRecovery();
		}
	}

	private settleReady(): void {
		if (this.readySettled) return;
		this.readySettled = true;
		if (this.readyTimer !== null) clearTimeout(this.readyTimer);
		this.readyTimer = null;
		this.resolveReady();
	}

	private dispatch(frame: NativeEventFrame): void {
		if (frame.channel === "native.resyncRequired") {
			this.options.onResyncRequired?.(frame.args?.[0]);
		}
		const listeners = this.listeners.get(frame.channel ?? "");
		if (!listeners || !Array.isArray(frame.args)) return;
		for (const listener of [...listeners]) listener(frame.args[0]);
	}

	/** Wait until the server has replayed missed events and announced its sequence. */
	ready(): Promise<void> {
		return this.readyPromise;
	}

	/** Apply the bootstrap snapshot, then deliver only events newer than that snapshot. */
	activateAfter(eventSeq: number): void {
		this.activated = true;
		for (const queued of this.queuedEvents) {
			if (queued.seq > eventSeq) this.dispatch(queued.frame);
		}
		this.queuedEvents.length = 0;
		this.lastEventSeq = Math.max(this.lastEventSeq, eventSeq);
	}

	getLastEventSeq(): number {
		return this.lastEventSeq;
	}

	getEventSourceGeneration(): string {
		return this.eventSourceGeneration;
	}

	/**
	 * Reconcile a heartbeat snapshot without treating an in-flight SSE frame as
	 * lost. Generation changes are definitive, while a sequence lag gets one
	 * short catch-up window so the normal SSE delivery can win the race.
	 */
	handleHeartbeat(state: NativeHeartbeatState): void {
		const generationMismatch =
			typeof state.eventSourceGeneration === "string" &&
			this.eventSourceGeneration !== state.eventSourceGeneration;
		if (generationMismatch) {
			// A new server starts a fresh sequence namespace. Do not send the old
			// server's cursor to it, or future low-numbered events could be skipped.
			this.cancelHeartbeatRecovery();
			this.lastEventSeq = 0;
			this.hasEventCursor = true;
			this.eventSourceGeneration = state.eventSourceGeneration ?? "";
			this.reconnect();
			return;
		}
		const expectedEventSeq =
			typeof state.eventSeq === "number" &&
			Number.isInteger(state.eventSeq) &&
			state.eventSeq >= 0
				? state.eventSeq
				: null;
		if (expectedEventSeq === null || this.lastEventSeq >= expectedEventSeq) return;
		this.heartbeatRecoveryExpectedSeq = Math.max(
			this.heartbeatRecoveryExpectedSeq ?? expectedEventSeq,
			expectedEventSeq,
		);
		if (this.heartbeatRecoveryTimer !== null) return;
		const recheck = (): void => {
			this.heartbeatRecoveryTimer = null;
			const expectedSeq = this.heartbeatRecoveryExpectedSeq;
			this.heartbeatRecoveryExpectedSeq = null;
			if (expectedSeq === null || this.lastEventSeq >= expectedSeq) return;
			// 游标仍在推进：SSE 在消化积压，继续观察；只有推进停滞才重连。
			if (Date.now() - this.lastEventProgressAt < NATIVE_EVENT_PROGRESS_GRACE_MS) {
				this.heartbeatRecoveryExpectedSeq = expectedSeq;
				this.heartbeatRecoveryTimer = setTimeout(recheck, NATIVE_HEARTBEAT_CATCHUP_DELAY_MS);
				return;
			}
			this.reconnect();
		};
		this.heartbeatRecoveryTimer = setTimeout(recheck, NATIVE_HEARTBEAT_CATCHUP_DELAY_MS);
	}

	private cancelHeartbeatRecovery(): void {
		if (this.heartbeatRecoveryTimer !== null) clearTimeout(this.heartbeatRecoveryTimer);
		this.heartbeatRecoveryTimer = null;
		this.heartbeatRecoveryExpectedSeq = null;
	}

	reconnect(): void {
		if (this.disposed) return;
		this.cancelHeartbeatRecovery();
		this.eventSource?.close();
		this.eventSource = null;
		this.connectEventSource();
	}

	async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
		if (this.disposed) throw new Error("Native desktop transport is disposed");
		const body = JSON.stringify({ channel, args });
		if (new TextEncoder().encode(body).byteLength > MAX_NATIVE_RPC_BODY_BYTES) {
			throw new Error("Native RPC request exceeds 32 MB");
		}
		const timeoutMs = nativeRpcTimeoutMs(channel);
		const controller = new AbortController();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
		}
		try {
			const response = await fetch(new URL("/__pideck/rpc", this.baseUrl), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-pideck-token": this.token,
				},
				body,
				signal: controller.signal,
			});
			let payload: NativeRpcResponse<T>;
			try {
				payload = (await response.json()) as NativeRpcResponse<T>;
			} catch {
				throw new Error(`Native RPC returned non-JSON response (${response.status})`);
			}
			if (!response.ok || !payload.ok) {
				throw new Error(payload.error?.message || `Native RPC failed (${response.status})`);
			}
			return payload.result as T;
		} catch (error) {
			if (timedOut && timeoutMs !== undefined) {
				throw new Error(`Native RPC timed out after ${timeoutMs}ms: ${channel}`);
			}
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
		let listeners = this.listeners.get(channel);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(channel, listeners);
		}
		const listener = callback as (payload: unknown) => void;
		listeners.add(listener);
		return () => {
			const current = this.listeners.get(channel);
			current?.delete(listener);
			if (current && current.size === 0) this.listeners.delete(channel);
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (!this.readySettled) this.settleReady();
		this.cancelHeartbeatRecovery();
		this.cancelClosedReconnect();
		this.eventSource?.close();
		this.eventSource = null;
		this.queuedEvents.length = 0;
		this.listeners.clear();
	}
}
