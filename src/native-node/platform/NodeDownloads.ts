import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import type {
	PlatformDownloadRequest,
	PlatformDownloads,
} from "../../main/platform/PlatformServices";
import { PlatformDownloadError as DownloadError } from "../../main/platform/PlatformServices";
import { NodeProxy } from "./NodeProxy";

/** Node/undici file downloader used by updates and other desktop services. */
export class NodeDownloads implements PlatformDownloads {
	constructor(private readonly proxy: NodeProxy) {}

	async downloadToFile(
		request: PlatformDownloadRequest,
	): Promise<{ receivedBytes: number; totalBytes?: number }> {
		let currentUrl = request.url;
		let response: Response | null = null;
		for (let redirect = 0; redirect < 10; redirect += 1) {
			response = await this.proxy.fetch(currentUrl, {
				method: "GET",
				headers: request.headers,
				redirect: "manual",
			});
			if (response.status < 300 || response.status >= 400) break;
			const location = response.headers.get("location");
			if (!location) break;
			currentUrl = new URL(location, currentUrl).toString();
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
		if (!response.body) throw new DownloadError("Download response has no body");

		const output = createWriteStream(request.filePath);
		let receivedBytes = 0;
		try {
			const reader = response.body.getReader();
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				const buffer = Buffer.from(next.value);
				receivedBytes += buffer.length;
				if (!output.write(buffer)) await new Promise<void>((resolveDrain) => output.once("drain", resolveDrain));
				request.onProgress?.({ receivedBytes, totalBytes });
			}
			await new Promise<void>((resolveEnd, rejectEnd) => {
				output.once("error", rejectEnd);
				output.end(() => resolveEnd());
			});
		} catch (error) {
			output.destroy();
			throw error;
		}

		// GitHub's asset size is a completion invariant, not just a progress hint.
		// A truncated response can otherwise look successful and leave a corrupt ZIP
		// for the user to extract manually.
		if (
			typeof request.expectedBytes === "number" &&
			Number.isFinite(request.expectedBytes) &&
			request.expectedBytes > 0 &&
			receivedBytes !== request.expectedBytes
		) {
			await rm(request.filePath, { force: true });
			throw new DownloadError(
				`Download size mismatch: expected ${request.expectedBytes}, got ${receivedBytes}`,
			);
		}
		return { receivedBytes, totalBytes };
	}
}
