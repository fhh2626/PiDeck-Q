import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	MEMORY_PROFILE_HEADER,
	toProfileCsvRow,
	type ProfileRowData,
} from "../../main/memory/memoryProfileCsv";

export interface NativeRendererDiagnostics {
	jsHeapKB?: number;
	totalJSHeapKB?: number;
	domNodes?: number;
	imgCount?: number;
	imgPixels?: number;
	canvasPixels?: number;
	workerCount?: number;
	workerJSHeapKB?: number;
}

/** Node-side replacement for Electron/CDP memory sampling. */
export class NativeMemoryMonitor {
	private readonly filePath: string;
	private timer: NodeJS.Timeout | null = null;
	private latestRenderer: NativeRendererDiagnostics = {};

	constructor(
		private readonly userDataDir: string,
		private readonly isStreaming: () => boolean,
		private readonly intervalMs = Number(process.env.PIDECK_MEMORY_PROFILE_INTERVAL_MS) || 5_000,
	) {
		this.filePath = join(userDataDir, "memory-profile", `profile-${Date.now()}.csv`);
	}

	async start(): Promise<void> {
		await mkdir(join(this.userDataDir, "memory-profile"), { recursive: true });
		await writeFile(this.filePath, `${MEMORY_PROFILE_HEADER}\n`, "utf8");
		this.timer = setInterval(() => void this.sample(), this.intervalMs);
		this.timer.unref();
		await this.sample();
	}

	updateRendererDiagnostics(diagnostics: NativeRendererDiagnostics): void {
		this.latestRenderer = { ...this.latestRenderer, ...diagnostics };
	}

	private async sample(): Promise<void> {
		const memory = process.memoryUsage();
		const renderer = this.latestRenderer;
		const row: ProfileRowData = {
			ts: Date.now(),
			type: "NodeSidecar",
			pid: process.pid,
			label: "native-node",
			rssKB: Math.round(memory.rss / 1024),
			privateKB: null,
			sharedKB: null,
			peakRssKB: null,
			heapUsedKB: Math.round(memory.heapUsed / 1024),
			jsHeapKB: renderer.jsHeapKB ?? null,
			totalJSHeapKB: renderer.totalJSHeapKB ?? null,
			domNodes: renderer.domNodes ?? null,
			imgCount: renderer.imgCount ?? null,
			imgPixels: renderer.imgPixels ?? null,
			canvasPixels: renderer.canvasPixels ?? null,
			workerCount: renderer.workerCount ?? null,
			workerJSHeapKB: renderer.workerJSHeapKB ?? null,
			streaming: this.isStreaming() ? 1 : 0,
		};
		await appendFile(this.filePath, `${toProfileCsvRow(row)}\n`, "utf8").catch(() => undefined);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
