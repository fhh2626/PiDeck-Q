import { memo } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow, SettingSwitchRow } from "./SettingRows";

/** 代理相关字段：用于判断代理 tab 是否有未保存变更。 */
const PROXY_FIELDS: (keyof AppSettings)[] = [
  "piProxyEnabled",
  "piProxyUrl",
  "piProxyBypass",
  "desktopProxyEnabled",
  "desktopProxyUrl",
  "desktopProxyBypass",
];

type ProxyTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
  piProxyChecking: boolean;
  piProxyNotice: string;
  piProxyNoticeTone: "info" | "success" | "error";
  onTestPiProxy: () => void;
};

/**
 * 设置弹框「代理设置」tab：pi / 桌面代理两段（未保存变更提示 + 统一保存/取消）。
 * 独立组件 + memo：切换 tab 或壳层无关状态变化时不重渲染本 tab。
 */
export const ProxyTab = memo(function ProxyTab(props: ProxyTabProps) {
  const { draft, updateDraft, isDirty } = props;
  // 代理 tab 仍展示未保存提示；实际保存/取消统一走全局草稿，避免旧 proxyDirty 局部状态残留。
  const proxyDirty = PROXY_FIELDS.some((field) => isDirty(field));

  return (
    <>
      {/* 未保存更改的提示横幅 */}
      {proxyDirty && (
        <div className="setting-proxy-unsaved-bar">
          <span className="setting-proxy-unsaved-dot" />
          <span>{t("settings.proxyUnsaved")}</span>
          <small>{t("settings.proxyApplyHint")}</small>
        </div>
      )}
      <SettingsSection
        title={t("settings.piProxy")}
        description={t("settings.piProxyDesc")}
      >
        <SettingSwitchRow
          title={t("settings.enablePiProxy")}
          description={t("settings.settingTakesEffectAfterRestart")}
          checked={draft.piProxyEnabled}
          onChange={(checked) =>
            updateDraft({ piProxyEnabled: checked })
          }
        />
        {draft.piProxyEnabled && (
          <div className="setting-proxy-panel">
            <SettingRow
              title={<span>{t("settings.proxyUrl")}</span>}
              stacked
            >
              <Input className="h-8" type="text" value={draft.piProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ piProxyUrl: event.target.value })} />
            </SettingRow>
            <SettingRow
              title={<span>{t("settings.proxyBypass")}</span>}
              description={t("settings.noProxyHint")}
              stacked
            >
              <Input className="h-8" type="text" value={draft.piProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ piProxyBypass: event.target.value })} />
            </SettingRow>
            <SettingRow
              title={<span>{t("settings.proxyTest")}</span>}
              description={
                <>
                  {t("settings.proxyNoApiKey")}
                  {props.piProxyNotice && (
                    <span className={`setting-status ${props.piProxyNoticeTone}`}>
                      {props.piProxyNotice}
                    </span>
                  )}
                </>
              }
            >
              <Button size="sm" variant="secondary"
                onClick={props.onTestPiProxy}
                disabled={props.piProxyChecking}
              >
                {props.piProxyChecking
                  ? t("settings.testingProxy")
                  : t("settings.testProxy")}
              </Button>
            </SettingRow>
          </div>
        )}
      </SettingsSection>
      <SettingsSection
        title={t("settings.desktopProxy")}
        description={t("settings.desktopProxyDesc")}
      >
        <SettingSwitchRow
          title={t("settings.enableDesktopProxy")}
          description={t("settings.desktopProxyDesc")}
          checked={draft.desktopProxyEnabled}
          onChange={(checked) =>
            updateDraft({ desktopProxyEnabled: checked })
          }
        />
        {draft.desktopProxyEnabled && (
          <div className="setting-proxy-panel">
            <SettingRow
              title={<span>{t("settings.proxyUrl")}</span>}
              stacked
            >
              <Input className="h-8" type="text" value={draft.desktopProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ desktopProxyUrl: event.target.value })} />
            </SettingRow>
            <SettingRow
              title={<span>{t("settings.proxyBypass")}</span>}
              description={t("settings.electronProxyHint")}
              stacked
            >
              <Input className="h-8" type="text" value={draft.desktopProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ desktopProxyBypass: event.target.value })} />
            </SettingRow>
          </div>
        )}
      </SettingsSection>
      {/* 代理变更走全局草稿：顶部统一保存/取消，不再在 tab 底部重复放按钮 */}
    </>
  );
});
