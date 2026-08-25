import type { DesktopRpcTransport } from "@shared/desktop/DesktopRpcTransport";

interface NativeRpcResponse<T> {
	ok: boolean;
	result?: T;
	error?: { message?: string };
}

interface NativeEventFrame {
	channel?: string;
	args?: unknown[];
}

/** HTTP + SSE transport used by the React page hosted by the native sidecar. */
export class NativeDesktopTransport implements DesktopRpcTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	private readonly eventSource: EventSource;
	private disposed = false;

	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
	) {
		const eventsUrl = new URL("/__pideck/events", this.baseUrl);
		eventsUrl.searchParams.set("token", token);
		this.eventSource = new EventSource(eventsUrl);
		this.eventSource.onmessage = (event) => {
			let frame: NativeEventFrame;
			try {
				frame = JSON.parse(event.data) as NativeEventFrame;
			} catch {
				return;
			}
			if (typeof frame.channel !== "string" || !Array.isArray(frame.args)) return;
			const listeners = this.listeners.get(frame.channel);
			if (!listeners) return;
			for (const listener of [...listeners]) listener(frame.args[0]);
		};
	}

	async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
		if (this.disposed) throw new Error("Native desktop transport is disposed");
		const response = await fetch(new URL("/__pideck/rpc", this.baseUrl), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-pideck-token": this.token,
			},
			body: JSON.stringify({ channel, args }),
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
		this.eventSource.close();
		this.listeners.clear();
	}
}
