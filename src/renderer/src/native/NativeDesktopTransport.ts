import type { DesktopRpcTransport } from "@shared/desktop/DesktopRpcTransport";
import { MAX_NATIVE_RPC_BODY_BYTES } from "@shared/desktop/nativeLimits";

interface NativeRpcResponse<T> {
	ok: boolean;
	result?: T;
	error?: { message?: string };
}

interface NativeEventFrame {
	channel?: string;
	args?: unknown[];
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
};

/** HTTP + replayable SSE transport used by the React page hosted by the native sidecar. */
export class NativeDesktopTransport implements DesktopRpcTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	private eventSource: EventSource | null = null;
	private readonly readyPromise: Promise<void>;
	private resolveReady!: () => void;
	private readonly queuedEvents: QueuedEvent[] = [];
	private activated = false;
	private disposed = false;
	private lastEventSeq = 0;
	private eventSourceGeneration = "";
	private hasEventCursor = false;

	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly options: NativeDesktopTransportOptions = {},
	) {
		this.readyPromise = new Promise<void>((resolve) => {
			this.resolveReady = resolve;
		});
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
		const eventSource = new EventSource(eventsUrl);
		this.eventSource = eventSource;
		eventSource.onmessage = (event) => this.handleEvent(event);
	}

	private handleEvent(event: MessageEvent<string>): void {
		const parsedSeq = Number(event.lastEventId);
		const seq = Number.isInteger(parsedSeq) && parsedSeq >= 0 ? parsedSeq : this.lastEventSeq;
		this.hasEventCursor = true;
		this.lastEventSeq = Math.max(this.lastEventSeq, seq);
		let frame: NativeEventFrame;
		try {
			frame = JSON.parse(event.data) as NativeEventFrame;
		} catch {
			return;
		}
		if (frame.channel === "native.eventChannelReady") {
			const payload = frame.args?.[0] as NativeEventChannelReady | undefined;
			if (typeof payload?.eventSeq === "number") {
				this.hasEventCursor = true;
				this.lastEventSeq = Math.max(this.lastEventSeq, payload.eventSeq);
			}
			if (typeof payload?.eventSourceGeneration === "string") this.eventSourceGeneration = payload.eventSourceGeneration;
			this.resolveReady();
			return;
		}
		if (typeof frame.channel !== "string" || !Array.isArray(frame.args)) return;
		if (!this.activated) {
			this.queuedEvents.push({ seq, frame });
			return;
		}
		this.dispatch(frame);
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
	 * Decide from the latest local cursor, not the cursor sampled when the
	 * heartbeat request was sent. The server's health flag can be stale when an
	 * SSE frame arrives while the heartbeat is in flight.
	 */
	shouldReconnectAfterHeartbeat(state: NativeHeartbeatState): boolean {
		const generationMismatch =
			typeof state.eventSourceGeneration === "string" &&
			this.eventSourceGeneration !== state.eventSourceGeneration;
		const serverEventSeq =
			typeof state.eventSeq === "number" &&
			Number.isInteger(state.eventSeq) &&
			state.eventSeq >= 0
				? state.eventSeq
				: null;
		const stillBehind = serverEventSeq !== null && this.lastEventSeq < serverEventSeq;
		return generationMismatch || stillBehind;
	}

	reconnect(): void {
		if (this.disposed) return;
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
		const response = await fetch(new URL("/__pideck/rpc", this.baseUrl), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-pideck-token": this.token,
			},
			body,
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
		this.eventSource?.close();
		this.eventSource = null;
		this.queuedEvents.length = 0;
		this.listeners.clear();
	}
}
