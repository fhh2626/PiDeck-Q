import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { NativeRpcRouter } from "../../main/transport/NativeRpcRouter";
import type { NativeClipboardSnapshot } from "../../shared/desktop/NativeHostTypes";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

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

type NativeBootstrap = {
	clipboard: Partial<NativeClipboardSnapshot>;
	settings: { zoomFactor: number };
};

type NativeRendererDependencies = {
	router: NativeRpcRouter;
	token: string;
	rendererRoot: string;
	backgroundDirectory: string;
	getBootstrap: () => Promise<NativeBootstrap>;
	onHeartbeat?: () => void;
	onMemoryDiagnostics?: (payload: unknown) => void;
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
		if (length > MAX_BODY_BYTES) throw new Error("Request body exceeds 32 MB");
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
	private readonly clients = new Set<ServerResponse>();
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private readonly deps: NativeRendererDependencies;

	constructor(deps: NativeRendererDependencies) {
		this.deps = deps;
	}

	async start(): Promise<{ host: string; port: number }> {
		if (this.address) return this.address;
		this.server = createServer((request, response) => {
			void this.handle(request, response).catch((error) => {
				if (response.headersSent) {
					response.destroy();
					return;
				}
				sendJson(response, 500, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
			});
		});
		this.server.on("error", (error) => {
			for (const client of this.clients) client.destroy(error instanceof Error ? error : undefined);
		});
		this.address = await new Promise<{ host: string; port: number }>((resolveAddress, reject) => {
			const server = this.server;
			if (!server) return reject(new Error("Native renderer server was not created"));
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				const address = server.address();
				if (!address || typeof address === "string") return reject(new Error("Native renderer server has no address"));
				resolveAddress({ host: "127.0.0.1", port: address.port });
			});
		});
		this.heartbeatTimer = setInterval(() => {
			for (const client of this.clients) client.write(": heartbeat\n\n");
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
			sendJson(response, 200, await this.deps.getBootstrap());
			return;
		}

		if (request.method === "GET" && url.pathname === "/__pideck/events") {
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-store",
				connection: "keep-alive",
			});
			response.write(": connected\n\n");
			this.clients.add(response);
			request.on("close", () => this.clients.delete(response));
			return;
		}

		if (request.method === "POST" && url.pathname === "/__pideck/heartbeat") {
			this.deps.onHeartbeat?.();
			response.writeHead(204).end();
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
			const data = await readFile(filePath);
			response.writeHead(200, {
				"content-type": MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
				"cache-control": "public, max-age=86400",
				"content-length": data.length,
			});
			response.end(data);
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
					const data = await readFile(fallback);
					response.writeHead(200, { "content-type": MIME_TYPES[".html"] });
					response.end(data);
					return;
				}
			}
			sendJson(response, 404, { ok: false, error: { message: "Not found" } });
			return;
		}
		const data = await readFile(filePath);
		if (data.length > MAX_FRAME_BYTES) {
			sendJson(response, 413, { ok: false, error: { message: "Asset exceeds 32 MB" } });
			return;
		}
		response.writeHead(200, { "content-type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream" });
		response.end(data);
	}

	broadcast(channel: string, args: unknown[]): void {
		const payload = JSON.stringify({ channel, args });
		if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return;
		const frame = `data: ${payload}\n\n`;
		for (const client of [...this.clients]) {
			try {
				client.write(frame);
			} catch {
				this.clients.delete(client);
			}
		}
	}

	getUrl(): string {
		if (!this.address) throw new Error("Native renderer server is not started");
		return `http://${this.address.host}:${this.address.port}/`;
	}

	async stop(): Promise<void> {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		for (const client of this.clients) client.end();
		this.clients.clear();
		const server = this.server;
		this.server = null;
		this.address = null;
		if (!server) return;
		server.closeIdleConnections?.();
		server.closeAllConnections?.();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}
