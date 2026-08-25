import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AppUpdateDownloadProgress,
	AppUpdateDownloadResult,
	AppUpdateInfo,
} from "../../../shared/types";

export type AppUpdateControllerApi = {
	checkUpdate: () => Promise<AppUpdateInfo>;
	downloadUpdate: (asset: NonNullable<AppUpdateInfo["recommendedAsset"]>) => Promise<AppUpdateDownloadResult>;
	openUpdatePackage: (filePath: string) => Promise<void>;
	onUpdateProgress?: (callback: (progress: AppUpdateDownloadProgress) => void) => () => void;
	openExternal?: (url: string) => Promise<void>;
};

export type AppUpdateControllerState = {
	info: AppUpdateInfo | null;
	error: string | null;
	checking: boolean;
	downloading: boolean;
	progress: AppUpdateDownloadProgress | null;
	downloadedPath: string | null;
	check: (source?: "auto" | "manual") => Promise<AppUpdateInfo | null>;
	download: () => Promise<string | null>;
	openPackage: () => Promise<void>;
	clear: () => void;
};

function errorMessage(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Electron progress events do not carry a request id. Keep a local gate so a
 * cleared overlay cannot start a replacement download until the old promise
 * settles; otherwise an old event could be mistaken for the new overlay's work.
 */
export function createAppUpdateDownloadGate() {
	let sequence = 0;
	let activeSequence = 0;
	let inFlightSequence = 0;
	let inFlight = false;
	return {
		begin(): number | null {
			if (inFlight) return null;
			activeSequence = ++sequence;
			inFlightSequence = activeSequence;
			inFlight = true;
			return activeSequence;
		},
		invalidate() {
			sequence += 1;
			activeSequence = 0;
		},
		acceptsProgress() {
			return inFlight && activeSequence !== 0 && activeSequence === sequence;
		},
		settle(requestSequence: number) {
			// The request may have been invalidated, so settle must release the gate
			// even when its active progress sequence was already cleared.
			if (inFlightSequence === requestSequence) {
				activeSequence = 0;
				inFlightSequence = 0;
				inFlight = false;
			}
		},
		isInFlight() {
			return inFlight;
		},
	};
}

/** App update lifecycle with stale-result protection for a closing/reopened overlay. */
export function useAppUpdateController(
	api: AppUpdateControllerApi,
	autoCheck = false,
): AppUpdateControllerState {
	const [info, setInfo] = useState<AppUpdateInfo | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [progress, setProgress] = useState<AppUpdateDownloadProgress | null>(null);
	const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
	const sequence = useRef(0);
	const mounted = useRef(true);
	const downloadGate = useRef(createAppUpdateDownloadGate());

	useEffect(() => {
		mounted.current = true;
		const unsubscribe = api.onUpdateProgress?.((next) => {
			if (mounted.current && downloadGate.current.acceptsProgress()) setProgress(next);
		});
		return () => {
			mounted.current = false;
			sequence.current += 1;
			downloadGate.current.invalidate();
			unsubscribe?.();
		};
	}, [api]);

	const check = useCallback(async (source: "auto" | "manual" = "manual") => {
		if (checking) return null;
		const requestSequence = ++sequence.current;
		setChecking(true);
		setError(null);
		try {
			const next = await api.checkUpdate();
			if (!mounted.current || requestSequence !== sequence.current) return null;
			setInfo(next.hasUpdate ? next : null);
			return next;
		} catch (reason) {
			if (mounted.current && requestSequence === sequence.current && source === "manual") setError(errorMessage(reason));
			return null;
		} finally {
			if (mounted.current && requestSequence === sequence.current) setChecking(false);
		}
	}, [api, checking]);

	useEffect(() => {
		if (autoCheck) void check("auto");
	}, [autoCheck, check]);

	const download = useCallback(async () => {
		const asset = info?.recommendedAsset;
		if (!asset || downloading) return null;
		const gateSequence = downloadGate.current.begin();
		if (gateSequence === null) return null;
		const controllerSequence = ++sequence.current;
		setDownloading(true);
		setError(null);
		setDownloadedPath(null);
		setProgress({ assetName: asset.name, receivedBytes: 0, totalBytes: asset.size, percent: 0, state: "downloading" });
		try {
			const result = await api.downloadUpdate(asset);
			if (!mounted.current || controllerSequence !== sequence.current) return null;
			setDownloadedPath(result.filePath);
			setProgress((current) => current ? { ...current, state: "completed", filePath: result.filePath, percent: 100 } : current);
			return result.filePath;
		} catch (reason) {
			if (mounted.current && controllerSequence === sequence.current) {
				setError(errorMessage(reason));
				setProgress((current) => current ? { ...current, state: "failed", error: errorMessage(reason) } : current);
			}
			return null;
		} finally {
			downloadGate.current.settle(gateSequence);
			if (mounted.current && controllerSequence === sequence.current) setDownloading(false);
		}
	}, [api, downloading, info]);

	const openPackage = useCallback(async () => {
		if (!downloadedPath) return;
		try {
			await api.openUpdatePackage(downloadedPath);
		} catch (reason) {
			if (mounted.current) setError(errorMessage(reason));
		}
	}, [api, downloadedPath]);

	const clear = useCallback(() => {
		sequence.current += 1;
		downloadGate.current.invalidate();
		setInfo(null);
		setError(null);
		setChecking(false);
		setDownloading(false);
		setProgress(null);
		setDownloadedPath(null);
	}, []);

	return { info, error, checking, downloading, progress, downloadedPath, check, download, openPackage, clear };
}
