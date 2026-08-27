import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import type {
	PlatformDownloadRequest,
	PlatformDownloads,
} from "../../main/platform/PlatformServices";
import { PlatformDownloadError as DownloadError } from "../../main/platform/PlatformServices";
import { NodeProxy } from "./NodeProxy";

export type NodeDownloadTimeoutOptions = {
	headerTimeoutMs?: number;
	bodyIdleTimeoutMs?: number;
	totalTimeoutMs?: number;
};

const DEFAULT_HEADER_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;

function positiveTimeout(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Node/undici file downloader used by updates and other desktop services. */
export class NodeDownloads implements PlatformDownloads {
	private readonly timeouts: Required<NodeDownloadTimeoutOptions>;

	constructor(private readonly proxy: NodeProxy, timeouts: NodeDownloadTimeoutOptions = {}) {
		this.timeouts = {
			headerTimeoutMs: positiveTimeout(timeouts.headerTimeoutMs, DEFAULT_HEADER_TIMEOUT_MS),
			bodyIdleTimeoutMs: positiveTimeout(timeouts.bodyIdleTimeoutMs, DEFAULT_BODY_IDLE_TIMEOUT_MS),
			totalTimeoutMs: positiveTimeout(timeouts.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS),
		};
	}

	async downloadToFile(
		request: PlatformDownloadRequest,
	): Promise<{ receivedBytes: number; totalBytes?: number }> {
		const downloadController = new AbortController();
		let abortReason: Error | null = null;
		let rejectDownloadAbort: ((reason: Error) => void) | null = null;
		const abortDownload = (reason: Error): void => {
			if (downloadController.signal.aborted) return;
			abortReason = reason;
			downloadController.abort(reason);
			rejectDownloadAbort?.(reason);
		};
		const totalTimeout = setTimeout(() => {
			abortDownload(new DownloadError("Download timed out"));
		}, this.timeouts.totalTimeoutMs);
		try {
			let currentUrl = request.url;
			let response: Response | null = null;
			let currentHeaders = { ...(request.headers ?? {}) };
			for (let redirect = 0; redirect < 10; redirect += 1) {
				const headerTimeout = setTimeout(() => {
					abortDownload(new DownloadError("Download response headers timed out"));
				}, this.timeouts.headerTimeoutMs);
				try {
					response = await this.proxy.fetch(currentUrl, {
						method: "GET",
						headers: currentHeaders,
						redirect: "manual",
						signal: downloadController.signal,
					});
				} catch (error) {
					if (downloadController.signal.aborted && abortReason) throw abortReason;
					throw error;
				} finally {
					clearTimeout(headerTimeout);
				}
				if (response.status < 300 || response.status >= 400) break;
				const location = response.headers.get("location");
				await response.body?.cancel().catch(() => undefined);
				if (!location) break;
				const nextUrl = new URL(location, currentUrl);
				const previousUrl = new URL(currentUrl);
				if (nextUrl.origin !== previousUrl.origin) {
					for (const key of Object.keys(currentHeaders)) {
						if (["authorization", "cookie", "proxy-authorization"].includes(key.toLowerCase())) delete currentHeaders[key];
					}
				}
				currentUrl = nextUrl.toString();
				request.onRedirect?.(currentUrl);
			}
			if (!response) throw new DownloadError("Download did not return a response");
			if (response.status < 200 || response.status >= 300) {
				throw new DownloadError(`HTTP ${response.status}`, response.status);
			}

			const rawLength = response.headers.get("content-length");
			const parsedLength = rawLength ? Number(rawLength) : NaN;
			const totalBytes = Number.isFinite(parsedLength) && parsedLength > 0
				? parsedLength
				: request.expectedBytes && request.expectedBytes > 0 ? request.expectedBytes : undefined;
			if (
				typeof request.expectedBytes === "number" &&
				request.expectedBytes > 0 &&
				Number.isFinite(parsedLength) &&
				parsedLength > request.expectedBytes
			) {
				await response.body?.cancel();
				throw new DownloadError(`Download size exceeds expected bytes: expected ${request.expectedBytes}, got ${parsedLength}`);
			}
			if (!response.body) throw new DownloadError("Download response has no body");

		const output = createWriteStream(request.filePath);
		let receivedBytes = 0;
		let outputError: Error | undefined;
		let resolveOutputError: (() => void) | undefined;
		const outputErrorReady = new Promise<void>((resolve) => {
			resolveOutputError = resolve;
		});
		// Install the listener before the first await/write. A WriteStream error must
		// never become an uncaught EventEmitter error while the network reader is busy.
		output.on("error", (error: unknown) => {
			if (outputError) return;
			outputError = error instanceof Error ? error : new Error(String(error));
			resolveOutputError?.();
		});
		const outputErrorSignal = outputErrorReady.then(() => ({
			type: "output-error" as const,
			error: outputError ?? new Error("Download output stream failed"),
		}));
		const downloadAbortSignal = new Promise<never>((_, reject) => {
			rejectDownloadAbort = reject;
			if (downloadController.signal.aborted) {
				reject(abortReason ?? new DownloadError("Download aborted"));
			}
		});
		const waitForOutputOr = async <T>(operation: Promise<T>): Promise<T> => {
			const result = await Promise.race([
				operation.then((value) => ({ type: "operation" as const, value })),
				outputErrorSignal,
				downloadAbortSignal,
			]);
			if (result.type === "output-error") throw result.error;
			return result.value;
		};
		const waitForOutputClose = () => waitForOutputOr(new Promise<void>((resolveClose) => {
			if (output.closed) {
				resolveClose();
				return;
			}
			output.once("close", resolveClose);
		}));
		const removePartialFile = async (): Promise<void> => {
			if (!output.closed) {
				await new Promise<void>((resolveClose) => {
					let settled = false;
					const settle = () => {
						if (settled) return;
						settled = true;
						resolveClose();
					};
					output.once("close", settle);
					output.destroy();
				});
			} else {
				output.destroy();
			}
			// Cleanup is best effort so the original network/write/mismatch error is
			// preserved for the caller and translated into the normal failed state.
			await rm(request.filePath, { force: true }).catch(() => undefined);
		};

		let cancelReader: (() => Promise<unknown>) | undefined;
		let removeAbortListener: (() => void) | undefined;
		try {
			const reader = response.body.getReader();
			cancelReader = () => reader.cancel();
			const abortReader = () => {
				void reader.cancel();
			};
			downloadController.signal.addEventListener("abort", abortReader, { once: true });
			removeAbortListener = () => downloadController.signal.removeEventListener("abort", abortReader);
			const readWithInactivityTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
				let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
				try {
					return await Promise.race([
						reader.read(),
						new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
							inactivityTimer = setTimeout(
								() => reject(new DownloadError("Download body timed out")),
								this.timeouts.bodyIdleTimeoutMs,
							);
						}),
					]);
				} finally {
					if (inactivityTimer !== null) clearTimeout(inactivityTimer);
				}
			};
			while (true) {
				const next = await waitForOutputOr(readWithInactivityTimeout());
				if (next.done) break;
				const buffer = Buffer.from(next.value);
				receivedBytes += buffer.length;
				if (typeof request.expectedBytes === "number" && request.expectedBytes > 0 && receivedBytes > request.expectedBytes) {
					await reader.cancel();
					throw new DownloadError(`Download size exceeds expected bytes: expected ${request.expectedBytes}, got ${receivedBytes}`);
				}
				if (!output.write(buffer)) {
					await waitForOutputOr(new Promise<void>((resolveDrain) => output.once("drain", resolveDrain)));
				}
				request.onProgress?.({ receivedBytes, totalBytes });
			}
			await waitForOutputOr(new Promise<void>((resolveEnd) => {
				output.end(() => resolveEnd());
			}));
			// WriteStream.end's callback can run before an asynchronous open/write error
			// is emitted. Wait for close so a successful result means the file lifecycle
			// really completed, not merely that end() was requested.
			await waitForOutputClose();

			// GitHub's asset size is a completion invariant, not just a progress hint.
			// A truncated response can otherwise look successful and leave a corrupt ZIP
			// for the user to extract manually.
			if (
				typeof request.expectedBytes === "number" &&
				Number.isFinite(request.expectedBytes) &&
				request.expectedBytes > 0 &&
				receivedBytes !== request.expectedBytes
			) {
				throw new DownloadError(
					`Download size mismatch: expected ${request.expectedBytes}, got ${receivedBytes}`,
				);
			}
			return { receivedBytes, totalBytes };
		} catch (error) {
			// If the output fails while reader.read() is pending, stop the network
			// stream as well; otherwise a failed disk write can keep the response alive.
			if (cancelReader) await cancelReader().catch(() => undefined);
			await removePartialFile();
			throw error;
		} finally {
			removeAbortListener?.();
		}
	} finally {
			clearTimeout(totalTimeout);
		}
	}
}
