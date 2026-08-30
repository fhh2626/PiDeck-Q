import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 5_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 250;

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

type PendingHello = {
	resolve: () => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
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
	private pendingHello: PendingHello | null = null;
	private writeBlocked = false;
	private pendingWriteBytes = 0;
	private readonly pendingWrites: Buffer[] = [];
	private readonly writeDrainWaiters = new Set<() => void>();
	private readonly fatalListeners = new Set<(error: Error) => void>();
	private closed = false;
	private authenticated = false;
	private closingIntentionally = false;
	private fatalError: Error | null = null;

	private readonly token: string;

	private constructor(token: string) {
		this.token = token;
	}

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
		try {
			this.send({ type: "hello", token: this.token });
		} catch (error) {
			this.handleClose(error instanceof Error ? error : new Error(String(error)));
		}
		await hello;
	}

	private waitForHello(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new Error("Native host hello handshake timed out");
				this.helloHandler = null;
				this.settleHello(error);
				this.handleClose(error);
			}, HELLO_TIMEOUT_MS);
			this.pendingHello = { resolve, reject, timer };
			this.helloHandler = (frame: HostFrame) => {
				if (frame.type !== "hello") return false;
				this.helloHandler = null;
				if (frame.ok) {
					this.authenticated = true;
					this.settleHello();
				} else {
					const error = new Error(frame.error?.message ?? "Native host authentication failed");
					this.settleHello(error);
					this.handleClose(error);
				}
				return true;
			};
		});
	}

	private helloHandler: ((frame: HostFrame) => boolean) | null = null;

	private settleHello(error?: Error): void {
		const pending = this.pendingHello;
		if (!pending) return;
		this.pendingHello = null;
		clearTimeout(pending.timer);
		if (error) pending.reject(error);
		else pending.resolve();
	}

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
		const socket = this.socket;
		if (!socket || this.closed) throw new Error("Native host connection is not available");
		const payload = Buffer.from(JSON.stringify(frame), "utf8");
		if (payload.length > MAX_FRAME_BYTES) throw new Error("Native host frame exceeds 32 MB");
		const prefix = Buffer.allocUnsafe(4);
		prefix.writeUInt32LE(payload.length, 0);
		const packet = Buffer.concat([prefix, payload]);
		if (socket.writableLength + this.pendingWriteBytes + packet.length > MAX_PENDING_WRITE_BYTES) {
			const error = new Error("Native host write backpressure limit exceeded");
			this.handleClose(error);
			throw error;
		}
		if (this.writeBlocked) {
			this.pendingWrites.push(packet);
			this.pendingWriteBytes += packet.length;
			return;
		}
		if (!socket.write(packet)) {
			this.writeBlocked = true;
			socket.once("drain", () => this.flushWrites());
		}
	}

	private flushWrites(): void {
		const socket = this.socket;
		if (!socket || this.closed) return;
		this.writeBlocked = false;
		while (this.pendingWrites.length > 0) {
			const packet = this.pendingWrites.shift();
			if (!packet) break;
			this.pendingWriteBytes -= packet.length;
			if (!socket.write(packet)) {
				this.writeBlocked = true;
				socket.once("drain", () => this.flushWrites());
				return;
			}
		}
		this.pendingWriteBytes = 0;
		this.notifyWriteDrain();
	}

	private notifyWriteDrain(): void {
		if (this.writeBlocked || this.pendingWrites.length > 0 || this.pendingWriteBytes > 0) return;
		for (const waiter of [...this.writeDrainWaiters]) waiter();
	}

	private waitForWriteDrain(socket: Socket, timeoutMs: number): Promise<boolean> {
		if (this.closed || this.socket !== socket) return Promise.resolve(false);
		if (!this.writeBlocked && this.pendingWrites.length === 0 && this.pendingWriteBytes === 0) {
			return Promise.resolve(true);
		}
		return new Promise<boolean>((resolve) => {
			let timer: NodeJS.Timeout | null = null;
			const waiter = () => {
				if (timer) clearTimeout(timer);
				timer = null;
				this.writeDrainWaiters.delete(waiter);
				resolve(!this.closed && this.socket === socket);
			};
			timer = setTimeout(() => {
				this.writeDrainWaiters.delete(waiter);
				resolve(false);
			}, timeoutMs);
			this.writeDrainWaiters.add(waiter);
		});
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

	/** Notify the sidecar when an authenticated host connection is lost unexpectedly. */
	onFatal(listener: (error: Error) => void): () => void {
		if (this.fatalError) {
			listener(this.fatalError);
			return () => undefined;
		}
		this.fatalListeners.add(listener);
		return () => {
			this.fatalListeners.delete(listener);
		};
	}

	close(): void {
		this.closingIntentionally = true;
		this.handleClose(new Error("Native host bridge disposed"));
	}

	/** Flush the lifecycle ACK and all custom queued packets before closing the TCP bridge. */
	async closeGracefully(): Promise<void> {
		this.closingIntentionally = true;
		const socket = this.socket;
		if (!socket || this.closed) return;
		const startedAt = Date.now();
		const drained = await this.waitForWriteDrain(socket, GRACEFUL_CLOSE_TIMEOUT_MS);
		if (!drained || this.closed || this.socket !== socket) {
			if (!this.closed) socket.destroy();
			this.handleClose(new Error("Native host bridge graceful close timed out"));
			return;
		}

		const remainingMs = Math.max(1, GRACEFUL_CLOSE_TIMEOUT_MS - (Date.now() - startedAt));
		await new Promise<void>((resolveClose) => {
			let settled = false;
			let timeout: NodeJS.Timeout | null = null;
			const onClose = () => settle();
			const onError = () => settle();
			const settle = () => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				timeout = null;
				socket.removeListener("close", onClose);
				socket.removeListener("error", onError);
				resolveClose();
			};
			timeout = setTimeout(() => {
				socket.destroy();
				settle();
			}, remainingMs);
			socket.once("close", onClose);
			socket.once("error", onError);
			try {
				socket.end();
			} catch {
				settle();
			}
		});
		this.handleClose(new Error("Native host bridge disposed"));
	}

	private handleClose(error: Error): void {
		if (this.closed) return;
		const isFatal = this.authenticated && !this.closingIntentionally;
		this.closed = true;
		this.helloHandler = null;
		this.settleHello(error);
		for (const waiter of [...this.writeDrainWaiters]) waiter();
		this.writeDrainWaiters.clear();
		this.socket?.destroy();
		this.socket = null;
		this.writeBlocked = false;
		this.pendingWriteBytes = 0;
		this.pendingWrites.length = 0;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.listeners.clear();
		if (isFatal) {
			// Preserve the failure for a listener registered just after connect()
			// resolves, closing the small socket-close registration race.
			this.fatalError = error;
			for (const listener of [...this.fatalListeners]) listener(error);
		}
		this.fatalListeners.clear();
	}
}
