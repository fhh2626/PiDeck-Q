import { BackgroundScanCoordinator } from "./BackgroundScanCoordinator";

/** A backend owns its scan history, queued work and disposal fence; no state leaks across instances. */
export class CatalogScanScope {
	private readonly scannedProjects = new Set<string>();
	private readonly coordinator = new BackgroundScanCoordinator(5000);
	private released = false;

	get disposed(): boolean { return this.released; }
	hasScanned(projectId: string): boolean { return this.scannedProjects.has(projectId); }
	markScanned(projectId: string): void {
		if (!this.released) this.scannedProjects.add(projectId);
	}

	/** Marks warm projects and schedules only while this backend is alive. */
	schedule(projectId: string, task: () => Promise<void>): boolean {
		if (this.released) return false;
		this.markScanned(projectId);
		return this.coordinator.schedule(projectId, async () => {
			if (!this.released) await task();
		});
	}

	dispose(): void {
		this.released = true;
		this.coordinator.dispose();
		this.scannedProjects.clear();
	}
}
