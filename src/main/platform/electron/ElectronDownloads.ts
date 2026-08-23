import { net } from "electron";
import { createWriteStream } from "node:fs";
import {
	PlatformDownloadError,
	type PlatformDownloadRequest,
	type PlatformDownloads,
} from "../PlatformServices";

export class ElectronDownloads implements PlatformDownloads {
	async downloadToFile(
		request: PlatformDownloadRequest,
	): Promise<{ receivedBytes: number; totalBytes?: number }> {
		return new Promise((resolve, reject) => {
			let receivedBytes = 0;
			let totalBytes =
				request.expectedBytes && request.expectedBytes > 0
					? request.expectedBytes
					: undefined;

			const req = net.request({ method: "GET", url: request.url });

			if (request.headers) {
				for (const [key, value] of Object.entries(request.headers)) {
					req.setHeader(key, value);
				}
			}

			req.on("redirect", (_statusCode, _method, redirectUrl) => {
				req.followRedirect();
				request.onRedirect?.(redirectUrl);
			});

			req.on("error", (error) => {
				reject(error);
			});

			req.on("response", (response) => {
				if (response.statusCode < 200 || response.statusCode >= 300) {
					reject(
						new PlatformDownloadError(
							`HTTP ${response.statusCode}`,
							response.statusCode,
						),
					);
					return;
				}

				const rawContentLength = Array.isArray(response.headers["content-length"])
					? response.headers["content-length"][0]
					: response.headers["content-length"];
				const contentLength = Number(rawContentLength);
				if (Number.isFinite(contentLength) && contentLength > 0) {
					totalBytes = contentLength;
				}

				const output = createWriteStream(request.filePath);

				output.on("error", (error) => {
					reject(error);
				});

				response.on("data", (chunk: Buffer) => {
					receivedBytes += chunk.length;
					const canContinue = output.write(chunk);
					const resp = response as unknown as { pause?: () => void; resume?: () => void };
					if (!canContinue && typeof resp.pause === "function") {
						resp.pause();
						output.once("drain", () => {
							resp.resume?.();
						});
					}
					request.onProgress?.({
						receivedBytes,
						totalBytes,
					});
				});

				response.on("error", (error) => {
					output.destroy();
					reject(error);
				});

				response.on("end", () => {
					output.end();
				});

				output.on("finish", () => {
					output.close(() => {
						resolve({ receivedBytes, totalBytes });
					});
				});
			});

			req.end();
		});
	}
}
