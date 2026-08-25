import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

type HostResponse = {
	type: "response";
	id: string;
	ok: boolean;
	result?: unknown;
	error?: { message?: string };
};

type HostEvent = {
	type: "event";
	name: string;
	payload?: unknown;
};

type HostFrame = HostResponse | HostEvent | { type: "hello"; ok: boolean; error?: { message?: string } };

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
};

/**
 * Length-prefixed JSON bridge between the Node sidecar and the Qt host.
 * The token handshake is completed before any OS request is allowed.
 */
export class HostBridge {
	private socket: Socket | null = null;
	private receiveBuffer = Buffer.alloc(0);
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	private closed = false;

	private constructor(private readonly token: string) {}

	static async connect(port: number, token: string): Promise<HostBridge> {
		const bridge = new HostBridge(token);
		await bridge.open(port);
		return bridge;
	}

	private async open(port: number): Promise<void> {
		this.socket = await new Promise<Socket>((resolve, reject) => {
			const socket = connect({ host: "127.0.0.1", port });
			const onError = (error: Error) => {
				socket.removeListener("connect", onConnect);
				reject(error);
			};
			const onConnect = () => {
				socket.removeListener("error", onError);
				resolve(socket);
			};
			socket.once("error", onError);
			socket.once("connect", onConnect);
		});

		this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
		this.socket.on("close", () => this.handleClose(new Error("Native host connection closed")));
		this.socket.on("error", (error) => this.handleClose(error));

		const hello = this.waitForHello();
		this.send({ type: "hello", token: this.token });
		await hello;
	}

	private waitForHello(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const handler = (frame: HostFrame) => {
				if (frame.type !== "hello") return false;
				if (frame.ok) resolve();
				else reject(new Error(frame.error?.message ?? "Native host authentication failed"));
				return true;
			};
			this.helloHandler = handler;
		});
	}

	private helloHandler: ((frame: HostFrame) => boolean) | null = null;

	private receive(chunk: Buffer): void {
		this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
		while (this.receiveBuffer.length >= 4) {
			const frameLength = this.receiveBuffer.readUInt32LE(0);
			if (frameLength > MAX_FRAME_BYTES) {
				this.handleClose(new Error("Native host frame exceeds 32 MB"));
				return;
			}
			if (this.receiveBuffer.length < frameLength + 4) return;
			const payload = this.receiveBuffer.subarray(4, frameLength + 4);
			this.receiveBuffer = this.receiveBuffer.subarray(frameLength + 4);
			let frame: HostFrame;
			try {
				frame = JSON.parse(payload.toString("utf8")) as HostFrame;
			} catch {
				this.handleClose(new Error("Native host sent invalid JSON"));
				return;
			}
			if (this.helloHandler?.(frame)) {
				this.helloHandler = null;
				continue;
			}
			this.dispatch(frame);
		}
	}

	private dispatch(frame: HostFrame): void {
		if (frame.type === "response") {
			const pending = this.pending.get(frame.id);
			if (!pending) return;
			this.pending.delete(frame.id);
			if (frame.ok) pending.resolve(frame.result);
			else pending.reject(new Error(frame.error?.message ?? "Native host request failed"));
			return;
		}
		if (frame.type !== "event") return;
		const listeners = this.listeners.get(frame.name);
		if (!listeners) return;
		for (const listener of [...listeners]) listener(frame.payload);
	}

	private send(frame: Record<string, unknown>): void {
		if (!this.socket || this.closed) throw new Error("Native host connection is not available");
		const payload = Buffer.from(JSON.stringify(frame), "utf8");
		if (payload.length > MAX_FRAME_BYTES) throw new Error("Native host frame exceeds 32 MB");
		const prefix = Buffer.allocUnsafe(4);
		prefix.writeUInt32LE(payload.length, 0);
		this.socket.write(Buffer.concat([prefix, payload]));
	}

	request<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
		const id = randomUUID();
		return new Promise<TResult>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value as TResult),
				reject,
			});
			try {
				this.send({ type: "request", id, method, params });
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	emit(name: string, payload: unknown): void {
		this.send({ type: "event", name, payload });
	}

	on<T>(name: string, listener: (payload: T) => void): () => void {
		let listeners = this.listeners.get(name);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(name, listeners);
		}
		const callback = listener as (payload: unknown) => void;
		listeners.add(callback);
		return () => {
			const current = this.listeners.get(name);
			current?.delete(callback);
			if (current && current.size === 0) this.listeners.delete(name);
		};
	}

	close(): void {
		this.handleClose(new Error("Native host bridge disposed"));
	}

	private handleClose(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.socket?.destroy();
		this.socket = null;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.listeners.clear();
	}
}
