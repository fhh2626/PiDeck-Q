import { useState, useCallback, useRef, useEffect } from "react";
import { useSetAtom } from "jotai";
import { t } from "../i18n";
import { settingsOpenAtom } from "../atoms";
import type {
  AppSettings,
  NpmAvailabilityResult,
  PiCliUpdateResult,
  PiInstallExecResult,
  PiInstallStatus,
  PiUpdateCheckResult,
} from "../../../shared/types";
import type { PiDesktopApi } from "@shared/desktop/createPiDesktopApi";

export interface UsePiUpdateOptions {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  showToast: (message: string, duration?: number) => void;
  api: PiDesktopApi;
}

export function usePiUpdate(options: UsePiUpdateOptions) {
  const {
    settings,
    setSettings,
    showToast,
    api,
  } = options;
  const setSettingsOpen = useSetAtom(settingsOpenAtom);

  // ---- Pi 环境状态（内部管理） ----
  const [piStatus, setPiStatus] = useState<PiInstallStatus | null>(null);
  const [piChecking, setPiChecking] = useState(false);
  const [environmentDialog, setEnvironmentDialog] = useState(false);

  // 恢复上次检测成功的缓存：打开开发设置直接显示（piInstall 来自 settings 持久化），
  // 不重复 spawn 检测；仅当本会话尚未检测过（piStatus 为 null）时生效。
  useEffect(() => {
    if (settings.piInstall && piStatus === null) {
      setPiStatus({
        installed: true,
        command: settings.piInstall.command,
        version: settings.piInstall.version,
        runtimeKind: settings.piInstall.runtimeKind,
        searchedDirs: [],
      });
    }
  }, [settings.piInstall, piStatus]);

  // ---- Pi 更新相关 state ----
  const [piUpdating, setPiUpdating] = useState(false);
  const [piUpdateChecking, setPiUpdateChecking] = useState(false);
  const [piUpdateCheck, setPiUpdateCheck] =
    useState<PiUpdateCheckResult | null>(null);
  const [piUpdateResult, setPiUpdateResult] =
    useState<PiCliUpdateResult | null>(null);

  // ---- Pi 代理相关 state ----
  const [piProxyNotice, setPiProxyNotice] = useState("");
  const [piProxyNoticeTone, setPiProxyNoticeTone] = useState<
    "info" | "success" | "error"
  >("info");
  const [piProxyChecking, setPiProxyChecking] = useState(false);

  // ---- 自定义 Pi 路径相关 state ----
  const [customPiPath, setCustomPiPath] = useState("");
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [customPathResult, setCustomPathResult] =
    useState<PiInstallStatus | null>(null);

  // ---- npm 安装相关 state ----
  const [npmAvailable, setNpmAvailable] = useState<boolean | null>(null);
  const [npmVersion, setNpmVersion] = useState<string | undefined>(undefined);
  const [npmChecking, setNpmChecking] = useState(false);
  const [installCommand, setInstallCommand] = useState(
    "npm install -g @earendil-works/pi-coding-agent",
  );
  const [installUseMirror, setInstallUseMirror] = useState(false);
  const [installExecuting, setInstallExecuting] = useState(false);
  const [installResult, setInstallResult] =
    useState<PiInstallExecResult | null>(null);
  const [installCompleted, setInstallCompleted] = useState(false);

  // ---- Pi 检测函数 ----
  // 检测成功后把命令路径/版本写入 settings 缓存：打开开发设置直接显示缓存结果，
  // 不重复 spawn 检测；手动点「检测环境」才重新探测。
  const persistPiInstall = useCallback(async (status: PiInstallStatus) => {
    if (status.installed && status.command && status.version) {
      const runtimePathPatch = status.command.startsWith("wsl -d ")
        ? {}
        : status.runtimeKind === "typescript" && !settings.piTypescriptPath
          ? { piTypescriptPath: status.command }
          : status.runtimeKind === "rust" && !settings.piRustPath
            ? { piRustPath: status.command }
            : {};
      return api.settings.update({
        piInstall: {
          command: status.command,
          version: status.version,
          runtimeKind: status.runtimeKind,
        },
        ...runtimePathPatch,
      });
    }
    // 未检测到：清除旧缓存，避免残留上一台机器/旧路径的结果
    return api.settings.update({ piInstall: undefined });
  }, [api, settings.piRustPath, settings.piTypescriptPath]);

  const checkPiInstall = useCallback(
    async (source: "startup" | "manual" = "manual") => {
      setSettingsOpen(false);
      setPiChecking(true);
      setEnvironmentDialog(true);
      try {
        const next = await api.pi.check();
        setPiStatus(next);
        // 检测结果缓存（含未检测到的清除）；startup 额外标记 piEnvironmentChecked
        const saved = await persistPiInstall(next);
        setSettings(saved);
        if (next.installed && source === "startup") {
          const marked = await api.settings.update({ piEnvironmentChecked: true });
          setSettings(marked);
          window.setTimeout(() => setEnvironmentDialog(false), 3000);
        }
        if (next.installed && source === "manual")
          window.setTimeout(() => setEnvironmentDialog(false), 3000);
      } finally {
        setPiChecking(false);
      }
    },
    [api, setPiStatus, setPiChecking, setSettings, setSettingsOpen, setEnvironmentDialog, persistPiInstall],
  );

  const checkPiInstallInline = useCallback(async () => {
    setPiChecking(true);
    setCustomPathResult(null);
    try {
      const next = await api.pi.check();
      setPiStatus(next);
      if (next.installed) {
        const saved = await persistPiInstall(next);
        const marked = await api.settings.update({ piEnvironmentChecked: true });
        setSettings({ ...saved, ...marked });
        showToast(
          t("app.piCheckPassed", {
            value: next.command ?? next.version ?? "pi",
          }),
        );
      } else {
        setSettingsOpen(false);
        setEnvironmentDialog(true);
        setPiStatus(next);
        // 未检测到：清除旧缓存
        const saved = await api.settings.update({ piInstall: undefined });
        setSettings(saved);
      }
    } finally {
      setPiChecking(false);
    }
  }, [api, persistPiInstall, setPiStatus, setPiChecking, setSettings, setSettingsOpen, setEnvironmentDialog]);

  /** 启动后的静默刷新：首装仍显示环境对话框，后续启动只更新版本/实现状态。 */
  const refreshPiStatus = useCallback(async () => {
    setPiChecking(true);
    try {
      const next = await api.pi.check();
      setPiStatus(next);
      const saved = await persistPiInstall(next);
      setSettings(saved);
    } finally {
      setPiChecking(false);
    }
  }, [api, persistPiInstall, setPiChecking, setPiStatus, setSettings]);

  // ---- 自定义 Pi 路径 ----
  const validateCustomPiPath = useCallback(
    async (options: { closeDialogOnSuccess?: boolean } = {}) => {
      const path = customPiPath.trim();
      if (!path) return;
      setCustomPathValidating(true);
      setCustomPathResult(null);
      try {
        const result = await api.pi.checkCustom(path);
        setCustomPathResult(result);
        if (result.installed) {
          const updated = await api.settings.get();
          setSettings(updated);
          setCustomPiPath(updated.customPiPath ?? result.command ?? path);
          setPiStatus(result);
          // 自定义路径检测成功同样写入缓存，打开设置直接显示
          void persistPiInstall(result);
          showToast(
            t("app.piPathSaved", {
              path: result.command ?? updated.customPiPath ?? path,
            }),
          );
          if (options.closeDialogOnSuccess) {
            window.setTimeout(() => setEnvironmentDialog(false), 3000);
          }
        } else {
          showToast(
            t("app.piPathValidateFailed", {
              error: result.error ?? t("environment.unableToRun"),
            }),
          );
        }
      } finally {
        setCustomPathValidating(false);
      }
    },
    [customPiPath, api, setPiStatus, setSettings, setEnvironmentDialog, persistPiInstall],
  );

  const clearCustomPiPath = useCallback(async () => {
    const updated = await api.settings.update({ customPiPath: "" });
    setSettings(updated);
    setCustomPiPath("");
    setCustomPathResult(null);
    showToast(t("app.piPathCleared"));
    const status = await api.pi.check();
    setPiStatus(status);
  }, [api, setPiStatus, setSettings]);

  // ---- npm ----
  const checkNpm = useCallback(async () => {
    setNpmChecking(true);
    try {
      const result = await api.pi.checkNpm();
      setNpmAvailable(result.available);
      setNpmVersion(result.version);
    } finally {
      setNpmChecking(false);
    }
  }, [api]);

  const execInstallCommand = useCallback(async () => {
    const cmd = installCommand.trim();
    if (!cmd) return;
    setInstallExecuting(true);
    setInstallResult(null);
    setInstallCompleted(false);
    try {
      const result = await api.pi.execInstall(cmd);
      setInstallResult(result);
      if (result.success && result.exitCode === 0) {
        setInstallCompleted(true);
      }
    } finally {
      setInstallExecuting(false);
    }
  }, [installCommand, api]);

  // ---- Pi CLI 更新 ----
  // 启动检查只执行一次：StrictMode 下 useEffect([]) 在 dev 双执行、settings.get
  // 的 .then 回调也会跑两遍，不加闸门会弹两次「Pi 不是最新版本」toast。
  // ref 置位在函数开头同步完成，两个并发回调先后到达时第二个直接跳过。
  const startupUpdateCheckDoneRef = useRef(false);
  const checkPiCliUpdateOnStartup = useCallback(async () => {
    if (settings.disableUpdateCheck) return;
    if (startupUpdateCheckDoneRef.current) return;
    startupUpdateCheckDoneRef.current = true;
    try {
      const result = await api.pi.checkUpdate();
      setPiUpdateCheck(result);
      if (result.hasUpdate) {
        const message = t("settings.piUpdateStartupNotice");
        showToast(message, 6500);
      }
    } catch {
      // 后台检查失败不打扰用户
    }
  }, [settings.disableUpdateCheck, api]);

  const checkPiCliUpdate = useCallback(async () => {
    if (settings.disableUpdateCheck) return;
    setPiUpdateChecking(true);
    try {
      const result = await api.pi.checkUpdate();
      setPiUpdateCheck(result);
      showToast(
        result.error
          ? t("settings.piUpdateFailed", { error: result.error })
          : result.hasUpdate
            ? t("settings.piUpdateAvailable")
            : t("settings.piUpdateChecked"),
      );
    } finally {
      setPiUpdateChecking(false);
    }
  }, [settings.disableUpdateCheck, api]);

  const updatePiCli = useCallback(async () => {
    setPiUpdating(true);
    setPiUpdateResult(null);
    try {
      const result = await api.pi.update();
      setPiUpdateResult(result);
      await checkPiInstallInline();
      setPiUpdateCheck(await api.pi.checkUpdate());
      showToast(
        result.updated
          ? t("settings.piUpdateDone")
          : t("settings.piUpdateChecked"),
      );
    } catch (error) {
      showToast(
        t("settings.piUpdateFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setPiUpdating(false);
    }
  }, [api, checkPiInstallInline]);

  // ---- Pi 代理测试 ----
  const testPiProxy = useCallback(async () => {
    setPiProxyChecking(true);
    setPiProxyNoticeTone("info");
    setPiProxyNotice(t("app.proxyChecking"));
    try {
      const result = await api.settings.testPiProxy();
      setPiProxyNoticeTone(result.success ? "success" : "error");
      setPiProxyNotice(
        result.success
          ? t("app.proxyAvailable", {
              message: result.message ?? t("app.proxyDefaultOk"),
              elapsed: result.elapsedMs,
            })
          : t("app.proxyCheckFailed", {
              error: result.error ?? t("app.proxyUnknownError"),
            }),
      );
    } catch (error) {
      setPiProxyNoticeTone("error");
      setPiProxyNotice(
        t("app.proxyCheckFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setPiProxyChecking(false);
    }
  }, [api]);

  return {
    // exposed state
    piStatus,
    setPiStatus,
    piChecking,
    environmentDialog,
    setEnvironmentDialog,
    piUpdating,
    piUpdateChecking,
    piUpdateCheck,
    piUpdateResult,
    piProxyNotice,
    piProxyNoticeTone,
    piProxyChecking,
    customPiPath,
    customPathValidating,
    customPathResult,
    installCommand,
    installUseMirror,
    installExecuting,
    installCompleted,
    installResult,
    npmChecking,
    npmAvailable,
    npmVersion,
    // setters
    setCustomPiPath,
    setCustomPathValidating,
    setCustomPathResult,
    setInstallCommand,
    setInstallUseMirror,
    setInstallExecuting,
    setInstallResult,
    setInstallCompleted,
    setNpmAvailable,
    setNpmVersion,
    setNpmChecking,
    setPiProxyNotice,
    setPiProxyNoticeTone,
    setPiProxyChecking,
    setPiUpdating,
    setPiUpdateChecking,
    setPiUpdateCheck,
    setPiUpdateResult,
    // functions
    checkPiInstall,
    checkPiInstallInline,
    refreshPiStatus,
    validateCustomPiPath,
    clearCustomPiPath,
    checkNpm,
    execInstallCommand,
    checkPiCliUpdateOnStartup,
    checkPiCliUpdate,
    updatePiCli,
    testPiProxy,
  };
}

export type PiUpdateController = ReturnType<typeof usePiUpdate>;
