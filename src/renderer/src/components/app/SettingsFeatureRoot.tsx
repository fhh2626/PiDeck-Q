import { lazy, Suspense, useMemo } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { AppInfo, AppSettings } from "../../../../shared/types";
import { settingsOpenAtom } from "../../atoms";
import { desktopApi as api } from "../../desktopApi";
import type { AppUpdateControllerState } from "../../hooks/useAppUpdateController";
import type { PiUpdateController } from "../../hooks/usePiUpdate";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

const SettingsModal = lazy(() =>
  import("./SettingsModal").then((module) => ({ default: module.SettingsModal })),
);

type SettingsFeatureRootProps = {
  settings: AppSettings;
  piUpdate: PiUpdateController;
  appUpdate: Pick<AppUpdateControllerState, "checking" | "error" | "check">;
  webServiceChanging: boolean;
  onRestartWebService: () => void;
  appInfo: AppInfo;
  onChange: (patch: Partial<AppSettings>) => void | Promise<void>;
  onCurrentVersion: (version: string) => void;
};

/** Owns Settings overlay visibility and modal-only commands without mirroring AppSettings. */
export function SettingsFeatureRoot(props: SettingsFeatureRootProps) {
  const open = useAtomValue(settingsOpenAtom);
  const setOpen = useSetAtom(settingsOpenAtom);

  // 按字段级 useMemo 稳定弹窗 props：App 根组件重渲染（低频）不会连带
  // 重渲染 SettingsModal（memo）。piUpdate 内部函数均为 useCallback，
  // 原语字段不变则引用不变。
  const modalProps = useMemo(
    () => ({
      settings: props.settings,
      piStatus: props.piUpdate.piStatus,
      piChecking: props.piUpdate.piChecking,
      piProxyChecking: props.piUpdate.piProxyChecking,
      piProxyNotice: props.piUpdate.piProxyNotice,
      piProxyNoticeTone: props.piUpdate.piProxyNoticeTone,
      webServiceChanging: props.webServiceChanging,
      appInfo: props.appInfo,
      customPiPath: props.piUpdate.customPiPath,
      customPathValidating: props.piUpdate.customPathValidating,
      customPathResult: props.piUpdate.customPathResult,
      updateChecking: props.appUpdate.checking,
      piUpdating: props.piUpdate.piUpdating,
      piUpdateChecking: props.piUpdate.piUpdateChecking,
      piUpdateCheck: props.piUpdate.piUpdateCheck,
      piUpdateResult: props.piUpdate.piUpdateResult,
      onCustomPathChange: (path: string) => {
        props.piUpdate.setCustomPiPath(path);
        props.piUpdate.setCustomPathResult(null);
      },
      onValidateCustomPath: props.piUpdate.validateCustomPiPath,
      onClearCustomPath: props.piUpdate.clearCustomPiPath,
      onCheckPi: props.piUpdate.checkPiInstallInline,
      onTestPiProxy: props.piUpdate.testPiProxy,
      onCheckUpdate: () => {
        void props.appUpdate.check("manual").then((info) => {
          if (info && !info.hasUpdate) {
            props.onCurrentVersion(info.currentVersion);
            showNotice(t("app.latestVersionNotice", { version: info.currentVersion }));
          } else if (!info && props.appUpdate.error) {
            showNotice(t("app.updateFailedNotice", { error: props.appUpdate.error }));
          }
        });
      },
      onCheckPiUpdate: props.piUpdate.checkPiCliUpdate,
      onUpdatePi: props.piUpdate.updatePiCli,
      onToggleDevTools: () => {
        void api.app.toggleDevTools().then((opened) => {
          showNotice(opened ? t("app.devToolsOpened") : t("app.devToolsClosed"));
        });
      },
      onRestartApp: () => api.app.restart(),
      onRestartWebService: props.onRestartWebService,
      onClearCheckFlag: async () => {
        await api.settings.update({ piEnvironmentChecked: false });
        showNotice(t("environment.checkFlagCleared"));
      },
      // 外部文档/服务页面通过 desktopApi.app.openExternal 交由系统默认浏览器打开。
      onOpenWebService: (port: string) => api.app.openExternal(`http://127.0.0.1:${port}`, true),
      onClose: () => setOpen(false),
      onChange: props.onChange,
    }),
    [
      props.settings,
      props.piUpdate.piStatus,
      props.piUpdate.piChecking,
      props.piUpdate.piProxyChecking,
      props.piUpdate.piProxyNotice,
      props.piUpdate.piProxyNoticeTone,
      props.webServiceChanging,
      props.appInfo,
      props.piUpdate.customPiPath,
      props.piUpdate.customPathValidating,
      props.piUpdate.customPathResult,
      props.appUpdate.checking,
      props.piUpdate.piUpdating,
      props.piUpdate.piUpdateChecking,
      props.piUpdate.piUpdateCheck,
      props.piUpdate.piUpdateResult,
      props.piUpdate.setCustomPiPath,
      props.piUpdate.setCustomPathResult,
      props.piUpdate.validateCustomPiPath,
      props.piUpdate.clearCustomPiPath,
      props.piUpdate.checkPiInstallInline,
      props.piUpdate.testPiProxy,
      props.appUpdate.check,
      props.appUpdate.error,
      props.onCurrentVersion,
      props.piUpdate.checkPiCliUpdate,
      props.piUpdate.updatePiCli,
      props.onRestartWebService,
      props.onChange,
    ],
  );

  if (!open) return null;

  return (
    <Suspense fallback={null}>
      <SettingsModal {...modalProps} />
    </Suspense>
  );
}
