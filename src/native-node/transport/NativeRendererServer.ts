import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { NativeRpcRouter } from "../../main/transport/NativeRpcRouter";
import type { NativeClipboardMetadata } from "../../shared/desktop/NativeHostTypes";
import { MAX_NATIVE_EVENT_FRAME_BYTES, MAX_NATIVE_RPC_BODY_BYTES } from "../../shared/desktop/nativeLimits.ts";

const MAX_BODY_BYTES = MAX_NATIVE_RPC_BODY_BYTES;
const MAX_FRAME_BYTES = MAX_NATIVE_EVENT_FRAME_BYTES;
const MAX_EVENT_HISTORY = 4_096;
const MAX_EVENT_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_EVENT_BYTES = 4 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

export type NativeBootstrap = {
	clipboard: Partial<NativeClipboardMetadata>;
	settings: { zoomFactor: number; memoryProfileEnabled: boolean };
	eventSeq?: number;
	eventSourceGeneration?: string;
};

type NativeEventRecord = {
	seq: number;
	frame: string;
	bytes: number;
};

type EventClient = {
	response: ServerResponse;
	blocked: boolean;
	pendingBytes: number;
	pendingFrames: string[];
};

type NativeHeartbeatPayload = {
	lastEventSeq?: number;
	eventSourceGeneration?: string;
};

type NativeHeartbeatState = {
	eventSeq: number;
	eventSourceGeneration: string;
	eventChannelHealthy: boolean;
};

class RequestBodyTooLargeError extends Error {
	constructor() {
		super("Request body exceeds 32 MB");
		this.name = "RequestBodyTooLargeError";
	}
}

type NativeRendererDependencies = {
	router: NativeRpcRouter;
	token: string;
	rendererRoot: string;
	backgroundDirectory: string;
	getBootstrap: () => Promise<NativeBootstrap>;
	onHeartbeat?: (payload: NativeHeartbeatPayload, state: NativeHeartbeatState) => void;
	onServerError?: (error: Error) => void;
	onMemoryDiagnostics?: (payload: unknown) => void;
	onOversizedEvent?: (channel: string, bytes: number) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > MAX_BODY_BYTES) throw new RequestBodyTooLargeError();
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload),
	});
	response.end(payload);
}

function isWithin(root: string, filePath: string): boolean {
	const relativePath = relative(root, filePath);
	return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !relativePath.includes(`..${sep}`));
}

function safeBackgroundPath(root: string, name: string): string | null {
	if (!/^bg-[a-zA-Z0-9.]+$/.test(name)) return null;
	const filePath = resolve(root, name);
	return isWithin(resolve(root), filePath) ? filePath : null;
}

/** Private loopback HTTP/SSE server used only by the native React surface. */
export class NativeRendererServer {
	private server: Server | null = null;
	private address: { host: string; port: number } | null = null;
	private readonly clients = new Set<EventClient>();
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private eventSeq = 0;
	private eventSourceGeneration = randomUUID();
	private readonly eventHistory: NativeEventRecord[] = [];
	private eventHistoryBytes = 0;
	private readonly deps: NativeRendererDependencies;

	constructor(deps: NativeRendererDependencies) {
		this.deps = deps;
	}

	async start(): Promise<{ host: string; port: number }> {
		if (this.address) return this.address;
		this.eventSourceGeneration = randomUUID();
		const server = createServer((request, response) => {
			void this.handle(request, response).catch((error) => {
				if (response.headersSent) {
					response.destroy();
					return;
				}
				if (error instanceof RequestBodyTooLargeError) {
					request.resume();
					sendJson(response, 413, { ok: false, error: { message: error.message } });
					return;
				}
				sendJson(response, 500, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
			});
		});
		this.server = server;
		server.on("error", (error) => {
			// An old generation may emit a delayed error after recovery installed a
			// new server. It must only close its own listener, never the replacement.
			if (this.server !== server) {
				if (server.listening) server.close();
				return;
			}
			const wasRunning = this.address !== null;
			const normalizedError = error instanceof Error ? error : new Error(String(error));
			this.server = null;
			this.address = null;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
			for (const client of [...this.clients]) client.response.destroy(normalizedError);
			this.clients.clear();
			this.eventSeq = 0;
			this.eventHistory.length = 0;
			this.eventHistoryBytes = 0;
			if (server.listening) server.close();
			// Initial listen failures are rejected by start(); only a server that was
			// already serving a renderer page needs the asynchronous recovery path.
			if (wasRunning) this.deps.onServerError?.(normalizedError);
		});
		this.address = await new Promise<{ host: string; port: number }>((resolveAddress, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				const address = server.address();
				if (!address || typeof address === "string") return reject(new Error("Native renderer server has no address"));
				resolveAddress({ host: "127.0.0.1", port: address.port });
			});
		});
		this.heartbeatTimer = setInterval(() => {
			for (const client of [...this.clients]) this.writeToClient(client, ": heartbeat\n\n");
		}, 15_000);
		this.heartbeatTimer.unref();
		return this.address;
	}

	private isAuthorized(request: IncomingMessage): boolean {
		const header = request.headers["x-pideck-token"];
		const supplied = Array.isArray(header) ? header[0] : header;
		const queryToken = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("token");
		return supplied === this.deps.token || queryToken === this.deps.token;
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const declaredLength = Number(request.headers["content-length"] ?? 0);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
			request.resume();
			sendJson(response, 413, { ok: false, error: { message: "Request body exceeds 32 MB" } });
			return;
		}
		if (url.pathname.startsWith("/__pideck/") && !this.isAuthorized(request)) {
			sendJson(response, 401, { ok: false, error: { message: "Unauthorized" } });
			return;
		}

		if (request.method === "POST" && url.pathname === "/__pideck/rpc") {
			const raw = await readRequestBody(request);
			const input: unknown = JSON.parse(raw);
			if (!isRecord(input) || typeof input.channel !== "string" || !Array.isArray(input.args)) {
				sendJson(response, 400, { ok: false, error: { message: "Invalid RPC request" } });
				return;
			}
			try {
				const result = await this.deps.router.invoke(input.channel, input.args);
				sendJson(response, 200, { ok: true, result });
			} catch (error) {
				sendJson(response, 200, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
			}
			return;
		}

		if (request.method === "GET" && url.pathname === "/__pideck/bootstrap") {
			// Capture the boundary before the async snapshot. Events produced while
			// clipboard/settings state is read stay queued and are replayed after the
			// renderer applies this snapshot instead of being silently dropped.
			const snapshotBoundary = this.eventSeq;
			const bootstrap = await this.deps.getBootstrap();
			sendJson(response, 200, {
				...bootstrap,
				eventSeq: snapshotBoundary,
				eventSourceGeneration: this.eventSourceGeneration,
			});
			return;
		}

		if (request.method === "GET" && url.pathname === "/__pideck/events") {
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-store",
				connection: "keep-alive",
			});
			const client: EventClient = { response, blocked: false, pendingBytes: 0, pendingFrames: [] };
			this.clients.add(client);
			const removeClient = () => this.clients.delete(client);
			request.on("close", removeClient);
			response.on("close", removeClient);
			this.writeToClient(client, ": connected\n\n");

			const rawHeaderLastEventId = request.headers["last-event-id"];
			const headerLastEventId = Array.isArray(rawHeaderLastEventId)
				? rawHeaderLastEventId[0]
				: rawHeaderLastEventId;
			const queryLastEventId = url.searchParams.get("lastEventId");
			const rawLastEventId = headerLastEventId ?? queryLastEventId ?? "";
			const lastEventId = Number(rawLastEventId);
			const hasLastEventId = Number.isInteger(lastEventId) && lastEventId >= 0;
			const oldestSeq = this.eventHistory[0]?.seq ?? this.eventSeq + 1;
			if (hasLastEventId && lastEventId < oldestSeq - 1) {
				this.writeControlEvent(client, "native.resyncRequired", {
					reason: "event-history-truncated",
					eventSeq: this.eventSeq,
				});
			} else if (hasLastEventId) {
				for (const record of this.eventHistory) {
					if (record.seq > lastEventId) this.writeToClient(client, record.frame);
				}
			}
			this.writeControlEvent(client, "native.eventChannelReady", {
				eventSeq: this.eventSeq,
				eventSourceGeneration: this.eventSourceGeneration,
			});
			return;
		}

		if (request.method === "POST" && url.pathname === "/__pideck/heartbeat") {
			const raw = await readRequestBody(request);
			let payload: NativeHeartbeatPayload = {};
			if (raw) {
				const parsed: unknown = JSON.parse(raw);
				if (!isRecord(parsed)) {
					sendJson(response, 400, { ok: false, error: { message: "Invalid heartbeat payload" } });
					return;
				}
				payload = {
					lastEventSeq: typeof parsed.lastEventSeq === "number" ? parsed.lastEventSeq : undefined,
					eventSourceGeneration: typeof parsed.eventSourceGeneration === "string" ? parsed.eventSourceGeneration : undefined,
				};
			}
			const state = this.getHeartbeatState(payload);
			this.deps.onHeartbeat?.(payload, state);
			sendJson(response, 200, state);
			return;
		}

		if (request.method === "POST" && url.pathname === "/__pideck/diagnostics/memory") {
			const body = await readRequestBody(request);
			this.deps.onMemoryDiagnostics?.(JSON.parse(body) as unknown);
			response.writeHead(204).end();
			return;
		}

		if (request.method === "GET" && url.pathname.startsWith("/__pideck/background/")) {
			let name: string;
			try {
				name = decodeURIComponent(url.pathname.slice("/__pideck/background/".length));
			} catch {
				sendJson(response, 403, { ok: false, error: { message: "Forbidden" } });
				return;
			}
			const filePath = safeBackgroundPath(this.deps.backgroundDirectory, name);
			if (!filePath) {
				sendJson(response, 403, { ok: false, error: { message: "Forbidden" } });
				return;
			}
			if (!existsSync(filePath)) {
				sendJson(response, 404, { ok: false, error: { message: "Not found" } });
				return;
			}
			await this.streamFile(response, filePath, MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream", "public, max-age=86400");
			return;
		}

		if (request.method !== "GET") {
			sendJson(response, 405, { ok: false, error: { message: "Method not allowed" } });
			return;
		}
		await this.serveStatic(url.pathname, response);
	}

	private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
		const requested = pathname === "/" || !extname(pathname) ? "/index.html" : pathname;
		const filePath = resolve(this.deps.rendererRoot, `.${requested}`);
		if (!isWithin(resolve(this.deps.rendererRoot), filePath) || !existsSync(filePath)) {
			if (requested !== "/index.html") {
				const fallback = resolve(this.deps.rendererRoot, "index.html");
				if (existsSync(fallback)) {
					await this.streamFile(response, fallback, MIME_TYPES[".html"]);
					return;
				}
			}
			sendJson(response, 404, { ok: false, error: { message: "Not found" } });
			return;
		}
		await this.streamFile(response, filePath, MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
	}

	private async streamFile(response: ServerResponse, filePath: string, contentType: string, cacheControl?: string): Promise<void> {
		let fileStat;
		try {
			fileStat = await stat(filePath);
		} catch {
			sendJson(response, 404, { ok: false, error: { message: "Not found" } });
			return;
		}
		if (!fileStat.isFile()) {
			sendJson(response, 404, { ok: false, error: { message: "Not found" } });
			return;
		}
		if (fileStat.size > MAX_FRAME_BYTES) {
			sendJson(response, 413, { ok: false, error: { message: "Asset exceeds 32 MB" } });
			return;
		}
		response.writeHead(200, {
			"content-type": contentType,
			...(cacheControl ? { "cache-control": cacheControl } : {}),
			"content-length": fileStat.size,
		});
		const stream = createReadStream(filePath);
		stream.on("error", () => response.destroy());
		stream.pipe(response);
	}

	broadcast(channel: string, args: unknown[]): void {
		const payload = JSON.stringify({ channel, args });
		const bytes = Buffer.byteLength(payload);
		if (bytes > MAX_FRAME_BYTES) {
			this.deps.onOversizedEvent?.(channel, bytes);
			this.appendEvent("native.resyncRequired", [{ channel, bytes }]);
			return;
		}
		this.appendEvent(channel, args);
	}

	private appendEvent(channel: string, args: unknown[]): void {
		const payload = JSON.stringify({ channel, args });
		const seq = ++this.eventSeq;
		const frame = `id: ${seq}\ndata: ${payload}\n\n`;
		const bytes = Buffer.byteLength(frame);
		this.eventHistory.push({ seq, frame, bytes });
		this.eventHistoryBytes += bytes;
		while (this.eventHistory.length > MAX_EVENT_HISTORY || this.eventHistoryBytes > MAX_EVENT_HISTORY_BYTES) {
			const removed = this.eventHistory.shift();
			if (!removed) break;
			this.eventHistoryBytes -= removed.bytes;
		}
		for (const client of [...this.clients]) this.writeToClient(client, frame);
	}

	private writeControlEvent(client: EventClient, channel: string, args: unknown): void {
		const payload = JSON.stringify({ channel, args: [args] });
		this.writeToClient(client, `id: ${this.eventSeq}\ndata: ${payload}\n\n`);
	}

	private writeToClient(client: EventClient, frame: string): boolean {
		if (client.response.destroyed) return false;
		const bytes = Buffer.byteLength(frame);
		if (client.blocked) {
			if (client.pendingBytes + bytes > MAX_PENDING_EVENT_BYTES) {
				this.clients.delete(client);
				client.response.destroy(new Error("Native event client backpressure limit exceeded"));
				return false;
			}
			client.pendingFrames.push(frame);
			client.pendingBytes += bytes;
			return false;
		}
		try {
			const writable = client.response.write(frame);
			if (!writable) {
				client.blocked = true;
				// The frame has already been accepted by ServerResponse. Only frames
				// waiting in pendingFrames count against the queued-byte budget.
				client.pendingBytes = 0;
				client.response.once("drain", () => this.flushClient(client));
			}
			return true;
		} catch {
			this.clients.delete(client);
			return false;
		}
	}

	private flushClient(client: EventClient): void {
		if (client.response.destroyed) return;
		client.blocked = false;
		while (client.pendingFrames.length > 0) {
			// Keep the not-yet-written tail in the queue. A write can transition the
			// response back to blocked, and the following drain must resume at the
			// exact next frame instead of losing anything removed into a local array.
			const frame = client.pendingFrames[0];
			const bytes = Buffer.byteLength(frame);
			try {
				const writable = client.response.write(frame);
				client.pendingFrames.shift();
				client.pendingBytes = Math.max(0, client.pendingBytes - bytes);
				if (!writable) {
					client.blocked = true;
					client.response.once("drain", () => this.flushClient(client));
					return;
				}
			} catch {
				this.clients.delete(client);
				return;
			}
		}
		client.pendingBytes = 0;
	}

	private getHeartbeatState(payload: NativeHeartbeatPayload): NativeHeartbeatState {
		const lastEventSeq = payload.lastEventSeq;
		const hasValidSequence = Number.isInteger(lastEventSeq) && Number(lastEventSeq) >= 0;
		const rendererSequence = hasValidSequence ? Number(lastEventSeq) : -1;
		return {
			eventSeq: this.eventSeq,
			eventSourceGeneration: this.eventSourceGeneration,
		// A sequence gap is a correctness failure, not a throughput metric: even
		// one missed terminal/session event can leave the renderer inconsistent.
			eventChannelHealthy: payload.eventSourceGeneration === this.eventSourceGeneration
			&& hasValidSequence
			&& rendererSequence >= this.eventSeq,
		};
	}

	getUrl(): string {
		if (!this.address) throw new Error("Native renderer server is not started");
		return `http://${this.address.host}:${this.address.port}/`;
	}

	async stop(): Promise<void> {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		for (const client of this.clients) client.response.end();
		this.clients.clear();
		const server = this.server;
		this.server = null;
		this.address = null;
		this.eventSeq = 0;
		this.eventHistory.length = 0;
		this.eventHistoryBytes = 0;
		if (!server) return;
		server.closeIdleConnections?.();
		server.closeAllConnections?.();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}
