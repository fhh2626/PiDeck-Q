import { useState, useMemo, useCallback } from "react";
import { t } from "../i18n";
import type {
  AppInfo,
  AppSettings,
  AppUpdateDownloadProgress,
  AppUpdateInfo,
} from "../../../shared/types";
import type { PiDesktopApi } from "@shared/desktop/createPiDesktopApi";

export interface UseAppUpdateOptions {
  api: PiDesktopApi;
  appInfo: AppInfo;
  settings: AppSettings;
  showToast: (message: string, duration?: number) => void;
}

export function useAppUpdate(options: UseAppUpdateOptions) {
  const { api, appInfo, settings, showToast } = options;

  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateProgress, setUpdateProgress] =
    useState<AppUpdateDownloadProgress | null>(null);
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<
    string | null
  >(null);
  const [upToDateVersion, setUpToDateVersion] = useState<string | null>(null);

  const downloadAppUpdate = useCallback(async () => {
    const asset = updateInfo?.recommendedAsset;
    if (!asset) {
      await api.app.openExternal(
        updateInfo?.releaseUrl ?? appInfo.releasesUrl,
      );
      return;
    }
    setUpdateDownloading(true);
    setDownloadedUpdatePath(null);
    setUpdateProgress({
      assetName: asset.name,
      receivedBytes: 0,
      totalBytes: asset.size,
      percent: 0,
      state: "downloading",
    });
    try {
      const result = await api.app.downloadUpdate(asset);
      setDownloadedUpdatePath(result.filePath);
      showToast(t("update.downloadCompleted"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateError(message);
      showToast(t("update.downloadFailed"));
    } finally {
      setUpdateDownloading(false);
    }
  }, [updateInfo, appInfo.releasesUrl, api, showToast]);

  const openDownloadedAppUpdate = useCallback(async () => {
    if (!downloadedUpdatePath) return;
    await api.app.openUpdatePackage(downloadedUpdatePath);
  }, [downloadedUpdatePath, api]);

  const checkAppUpdate = useCallback(
    async (source: "auto" | "manual" = "manual") => {
      if (updateChecking) return;
      if (source === "auto" && settings.disableUpdateCheck) return;
      setUpdateChecking(true);
      try {
        const next = await api.app.checkUpdate();
        if (next.hasUpdate) {
          setUpdateInfo(next);
        } else if (source === "manual") {
          setUpToDateVersion(next.currentVersion);
          showToast(
            t("app.latestVersionNotice", { version: next.currentVersion }),
          );
        }
      } catch (error) {
        if (source === "manual") {
          const message =
            error instanceof Error ? error.message : String(error);
          showToast(t("app.updateFailedNotice", { error: message }));
          setUpdateError(message);
          showToast(t("app.updateFailed"));
        }
      } finally {
        setUpdateChecking(false);
      }
    },
    [updateChecking, settings.disableUpdateCheck, api, showToast],
  );

  const appUpdateController = useMemo(
    () => ({
      info: updateInfo,
      error: updateError,
      checking: updateChecking,
      downloading: updateDownloading,
      progress: updateProgress,
      downloadedPath: downloadedUpdatePath,
      download: async () => {
        await downloadAppUpdate();
        return downloadedUpdatePath;
      },
      openPackage: async () => {
        if (downloadedUpdatePath)
          await api.app.openUpdatePackage(downloadedUpdatePath);
      },
      clear: () => {
        setUpdateInfo(null);
        setUpdateError(null);
        setUpdateProgress(null);
        setDownloadedUpdatePath(null);
        setUpToDateVersion(null);
      },
      check: checkAppUpdate as unknown as (source?: "auto" | "manual") => Promise<AppUpdateInfo | null>,
    }),
    [
      updateInfo,
      updateError,
      updateChecking,
      updateDownloading,
      updateProgress,
      downloadedUpdatePath,
      downloadAppUpdate,
      checkAppUpdate,
      api,
    ],
  );

  return {
    updateInfo,
    updateError,
    updateChecking,
    updateDownloading,
    updateProgress,
    downloadedUpdatePath,
    upToDateVersion,
    appUpdateController,
    setUpdateInfo,
    setUpdateError,
    setUpdateChecking,
    setUpdateDownloading,
    setUpdateProgress,
    setDownloadedUpdatePath,
    setUpToDateVersion,
    checkAppUpdate,
    downloadAppUpdate,
    openDownloadedAppUpdate,
  };
}
