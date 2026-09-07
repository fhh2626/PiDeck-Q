import { memo, useEffect, useState } from "react";
import QRCode from "qrcode";
import { RotateCw } from "lucide-react";
import type {
  AppInfo,
  AppSettings,
  PiCliUpdateResult,
  PiInstallStatus,
  PiUpdateCheckResult,
  WebNetworkAddress,
} from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingRow, SettingSwitchRow } from "./SettingRows";
import { ExternalEditorsSection } from "./ExternalEditorsSection";
import { cn } from "../../../lib/utils";

type DevTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
  appInfo: AppInfo;
  piStatus: PiInstallStatus | null;
  piChecking: boolean;
  customPiPath: string;
  customPathValidating: boolean;
  customPathResult: PiInstallStatus | null;
  onCustomPathChange: (path: string) => void;
  onValidateCustomPath: () => void;
  onClearCustomPath: () => void;
  onCheckPi: () => void;
  onClearCheckFlag?: () => void;
  piUpdateChecking: boolean;
  onCheckPiUpdate: () => void;
  piUpdating: boolean;
  onUpdatePi: () => void;
  piUpdateCheck: PiUpdateCheckResult | null;
  piUpdateResult: PiCliUpdateResult | null;
  updateChecking: boolean;
  onCheckUpdate: () => void;
  webServiceChanging: boolean;
  onOpenWebService: (port: string) => void;
  onRestartWebService: () => void;
  onToggleDevTools: () => void;
  onRestartApp: () => void;
  /** 壳层「取消」递增；本 tab 借此重置 WSL / Web 端口等局部状态 */
  resetKey: number;
};

/** 下拉选项：disabled 可选（SelectItem 透传） */
type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 设置弹框「开发设置」tab：环境/版本更新/运行参数/Web 本地服务/外部编辑器/调试/隐私。
 * 独立组件 + memo：WSL 与 Web 服务地址等局部状态自持，只有进入本 tab 才加载。
 */
export const DevTab = memo(function DevTab(props: DevTabProps) {
  const { draft, updateDraft, isDirty } = props;
  const piPath = props.customPiPath || props.piStatus?.command || "";

  // ── WSL 相关状态（仅 Windows + WSL 开启时拉取）──
  const [wslUserInput, setWslUserInput] = useState(draft.wslUser);
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [wslDistrosLoading, setWslDistrosLoading] = useState(false);
  const [wslDistrosAttempted, setWslDistrosAttempted] = useState(false);
  const [wslValidating, setWslValidating] = useState(false);
  const [wslValidation, setWslValidation] = useState<{
    ok: boolean;
    whoami: string;
    piVersion: string;
    error: string;
  } | null>(null);
  // WSL 发行版列表懒加载（仅 Windows + WSL 开启时拉取，无论成败只拉一次）
  useEffect(() => {
    const isWin = props.appInfo.platform === "win32";
    if (isWin && draft.wslEnabled && !wslDistrosAttempted && !wslDistrosLoading && window.piDesktop.wsl) {
      setWslDistrosLoading(true);
      window.piDesktop.wsl
        .listDistros()
        .then((list) => { setWslDistros(list); setWslDistrosAttempted(true); })
        .catch(() => { setWslDistros([]); setWslDistrosAttempted(true); })
        .finally(() => setWslDistrosLoading(false));
    }
  }, [draft.wslEnabled, wslDistrosAttempted, wslDistrosLoading, props.appInfo.platform]);

  const distroOptions: SelectOption[] = wslDistros.length > 0
    ? wslDistros.map((d) => ({ value: d, label: d }))
    : [{ value: draft.wslDistro, label: draft.wslDistro }];

  const handleValidateWslUser = async () => {
    if (!window.piDesktop.wsl) {
      setWslValidation({ ok: false, whoami: "", piVersion: "", error: t("settings.wsl.apiUnavailable") });
      return;
    }
    setWslValidating(true);
    setWslValidation(null);
    try {
      const result = await window.piDesktop.wsl.validateConnection(draft.wslDistro, wslUserInput);
      setWslValidation(result);
      if (result.ok) {
        // 验证通过后，将用户输入写入 draft
        updateDraft({ wslUser: wslUserInput });
      }
    } catch (err) {
      console.error("[Settings] WSL validation failed", err);
      setWslValidation({ ok: false, whoami: "", piVersion: "", error: t("settings.wsl.validationFailed") });
    } finally {
      setWslValidating(false);
    }
  };

  // ── Web 服务端口/网卡/二维码（只在本 tab 展示）──
  const [webPortDraft, setWebPortDraft] = useState(String(draft.webServicePort));
  const [webNetworkAddresses, setWebNetworkAddresses] = useState<WebNetworkAddress[]>([]);
  const [selectedWebAddress, setSelectedWebAddress] = useState("");
  const [webQrDataUrl, setWebQrDataUrl] = useState("");
  const [webNetworkLoading, setWebNetworkLoading] = useState(false);

  const applyWebPortDraft = () => {
    const port = Number(webPortDraft);
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== draft.webServicePort) {
      updateDraft({ webServicePort: port });
    } else {
      setWebPortDraft(String(draft.webServicePort));
    }
  };

  // 网卡地址只在设置弹框内展示；优先局域网 IPv4，VPN/虚拟网卡仍保留为可选入口。
  useEffect(() => {
    const loadAddresses = desktopApi.app.networkAddresses;
    if (typeof loadAddresses !== "function") return;
    let active = true;
    setWebNetworkLoading(true);
    void loadAddresses()
      .then((addresses) => {
        if (!active) return;
        setWebNetworkAddresses(addresses);
        setSelectedWebAddress((current) =>
          addresses.some((item) => item.address === current)
            ? current
            : addresses.find((item) => item.isPrivate)?.address ?? addresses[0]?.address ?? "",
        );
      })
      .catch(() => {
        if (active) setWebNetworkAddresses([]);
      })
      .finally(() => {
        if (active) setWebNetworkLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const webAccessUrl = selectedWebAddress
    ? `http://${selectedWebAddress}:${webPortDraft || draft.webServicePort}`
    : "";

  // URL 或开关变化时重新编码，二维码只保存 data URL，不把主进程能力暴露给页面。
  useEffect(() => {
    if (!draft.webServiceEnabled || !webAccessUrl) {
      setWebQrDataUrl("");
      return;
    }
    let active = true;
    void QRCode.toDataURL(webAccessUrl, {
      width: 192,
      margin: 1,
      color: { dark: "#111827", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (active) setWebQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setWebQrDataUrl("");
      });
    return () => {
      active = false;
    };
  }, [draft.webServiceEnabled, webAccessUrl]);

  // 壳层「取消」：重置本 tab 局部编辑态（WSL 输入、Web 端口）
  useEffect(() => {
    setWslValidation(null);
    setWslUserInput(draft.wslUser);
    setWebPortDraft(String(draft.webServicePort));
  }, [props.resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const disableUpdateCheck = draft.disableUpdateCheck;

  const piSourceOptions: SelectOption[] = [
    { value: "windows", label: t("settings.piSource.windows") },
    { value: "wsl", label: t("settings.piSource.wsl") },
  ];

  return (
    <>
      {/* 环境 */}
      {/* 开发设置 tab 不自动检测 pi：检测结果缓存在 settings.piInstall（打开时直接显示），
          只有用户手动点「检测环境」才重新 spawn 探测（曾因自动检测在打开设置时触发双弹窗）。 */}
      <SettingsSection title={t("settings.environment")}>
        {/* Pi CLI 状态：安装检测 + 路径信息 + 重新检测 */}
        <div className="setting-pi-status">
          <div className="setting-pi-status-indicator">
            <span
              className={"pi-status-dot " + (props.piStatus?.installed ? "online" : "offline")}
            />
            <div className="setting-pi-status-text">
              <strong>Pi CLI</strong>
              <span>
                {props.piStatus
                  ? props.piStatus.installed
                    ? t("settings.foundPi", {
                        version: props.piStatus.version ?? "pi",
                      })
                    : t("settings.piMissing")
                  : t("settings.piCliAvailable")}
              </span>
              {piPath && (
                <span className="setting-path">
                  {piPath}
                </span>
              )}
              {props.piStatus && !props.piStatus.installed && props.piStatus.error && (
                <span className="setting-status error">
                  {props.piStatus.error}
                </span>
              )}
            </div>
          </div>
          <div className="setting-inline-actions">
            <Button variant="secondary" onClick={props.onCheckPi} disabled={props.piChecking}>
              {props.piChecking
                ? t("settings.detecting")
                : t("settings.detectEnvironment")}
            </Button>
            {props.onClearCheckFlag && (
              <Button variant="secondary"
                onClick={props.onClearCheckFlag}
              >
                {t("environment.clearCheckFlag")}
              </Button>
            )}
            <Button variant="secondary"
              onClick={props.onCheckPiUpdate}
              loading={props.piUpdateChecking}
              disabled={disableUpdateCheck}
            >
              {t("settings.checkPiUpdate")}
            </Button>
            <Button variant="secondary"
              onClick={props.onUpdatePi}
              loading={props.piUpdating}
              disabled={
                disableUpdateCheck ||
                !props.piUpdateCheck?.hasUpdate
              }
            >
              {t("settings.updatePi")}
            </Button>
          </div>
        </div>
        {props.piUpdateResult && (
          <pre className="setting-update-output">
            {props.piUpdateResult.command}
            {"\n"}
            {props.piUpdateResult.output}
          </pre>
        )}

        <div className="my-3 border-0 border-t border-border-subtle" />

        {/* Pi 来源：Windows 原生 / WSL（仅 Windows 可见） */}
        {props.appInfo.platform === "win32" && (
          <div className="setting-pi-source-block">
            <div className="setting-pi-source-row">
              <span>{t("settings.piSource.label")}</span>
              <div className="grid gap-1.5">
                <Select value={draft.wslEnabled ? "wsl" : "windows"} onValueChange={(value) => {
                  updateDraft({ wslEnabled: value === "wsl" });
                  setWslValidation(null);
                }}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {piSourceOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {draft.wslEnabled && (
              <div className="setting-pi-wsl-config">
                <div className="setting-wsl-fields">
                  {wslDistros.length > 0 ? (
                    <div className="grid min-w-[160px] flex-1 gap-1.5">
                      <span className="text-control font-medium text-foreground">{t("settings.wsl.distro")}</span>
                      <Select value={draft.wslDistro} onValueChange={(value) => {
                        updateDraft({ wslDistro: value });
                        setWslValidation(null);
                      }}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {distroOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <div className="grid min-w-[160px] flex-1 gap-1.5">
                      <span className="text-control font-medium text-foreground">{t("settings.wsl.distro")}</span>
                      <Input type="text" value={draft.wslDistro} placeholder={"Ubuntu"} onChange={(event) => {
                        updateDraft({ wslDistro: event.target.value });
                        setWslValidation(null);
                      }} />
                    </div>
                  )}
                  {wslDistrosLoading && (
                    <small className="setting-status info">{t("settings.wsl.detectingDistros")}</small>
                  )}
                  <div className="setting-wsl-user-row">
                    <div className="grid min-w-[160px] flex-1 gap-1.5">
                      <span className="text-control font-medium text-foreground">{t("settings.wsl.user")}</span>
                      <Input type="text" value={wslUserInput} placeholder={"root"} onChange={(event) => {
                        setWslUserInput(event.target.value);
                        setWslValidation(null);
                      }} />
                    </div>
                    <Button variant="secondary"
                      size="sm"
                      disabled={!wslUserInput.trim() || wslValidating}
                      loading={wslValidating}
                      onClick={handleValidateWslUser}
                    >
                      {t("settings.wsl.validateUser")}
                    </Button>
                  </div>
                </div>
                {wslValidation && (
                  <div className={`setting-wsl-validation ${wslValidation.ok ? "success" : "error"}`}>
                    {wslValidation.ok ? (
                      <>
                        <small className="setting-status success">
                          {t("settings.wsl.validationOk", {
                            user: wslValidation.whoami,
                            distro: draft.wslDistro,
                          })}
                        </small>
                        {wslValidation.piVersion ? (
                          <small className="setting-status success">
                            {t("settings.wsl.piDetected", { version: wslValidation.piVersion })}
                          </small>
                        ) : (
                          <small className="setting-status warning">
                            {wslValidation.error || t("settings.wsl.piNotInstalled")}
                          </small>
                        )}
                      </>
                    ) : (
                      <small className="setting-status error">{wslValidation.error}</small>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="my-3 border-0 border-t border-border-subtle" />

        
        <div className="my-3 border-0 border-t border-border-subtle" />

        <div className="setting-pi-runtime-panel">
          <SettingRow title={<span>{t("settings.piRuntimePreference")}</span>} description={t("settings.piRuntimePreferenceHint")}>
            <Select value={draft.piRuntimePreference} onValueChange={(value) => updateDraft({ piRuntimePreference: value as AppSettings["piRuntimePreference"] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("settings.piRuntimePreferenceAuto")}</SelectItem>
                <SelectItem value="typescript">{t("settings.piRuntimePreferenceTypescript")}</SelectItem>
                <SelectItem value="rust">{t("settings.piRuntimePreferenceRust")}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title={<span>{t("settings.piTypescriptPath")}</span>} description={t("settings.piTypescriptPathHint")} stacked>
            <Input type="text" value={draft.piTypescriptPath} placeholder={t("settings.piTypescriptPathPlaceholder")} onChange={(event) => updateDraft({ piTypescriptPath: event.target.value })} />
          </SettingRow>
          <SettingRow title={<span>{t("settings.piRustPath")}</span>} description={t("settings.piRustPathHint")} stacked>
            <Input type="text" value={draft.piRustPath} placeholder={t("settings.piRustPathPlaceholder")} onChange={(event) => updateDraft({ piRustPath: event.target.value })} />
          </SettingRow>
        </div>

        {/* 自定义 Pi 路径 */}
        <div className="setting-pi-path-panel">
          <SettingRow
            title={<span>{t("settings.customPiPath")}</span>}
            description={t("settings.customPiPathHint")}
            stacked
          >
            <Input type="text" value={props.customPiPath} placeholder={
              piPath ||
              "D:\\mise-data\\installs\\node\\24 13 0\\pi.cmd"
            } disabled={props.customPathValidating} onChange={(event) => props.onCustomPathChange(event.target.value)} />
          </SettingRow>
          <div className="setting-pi-path-actions">
            <Button variant="secondary"
              onClick={props.onValidateCustomPath}
              disabled={!props.customPiPath.trim() || props.customPathValidating}
            >
              {props.customPathValidating
                ? t("settings.validating")
                : t("settings.validatePiPath")}
            </Button>
            <Button variant="secondary"
              onClick={props.onClearCustomPath}
              disabled={!props.customPiPath || props.customPathValidating}
            >
              {t("settings.clearCustomPiPath")}
            </Button>
          </div>
          {props.customPathResult && (
            <small className={`setting-status ${props.customPathResult.installed ? "success" : "error"}`}>
              {props.customPathResult.installed
                ? t("settings.validatePassed", {
                    value:
                      props.customPathResult.command ??
                      props.customPathResult.version ??
                      "pi",
                  })
                : t("settings.validateFailed", {
                    error:
                      props.customPathResult.error ??
                      t("environment.unableToRun"),
                  })}
            </small>
          )}
        </div>
      </SettingsSection>

      {/* 版本与更新 */}
      <SettingsSection title={t("settings.sectionUpdates")}>
        <SettingRow
          title={
            <>
              <span>PiDeck-Q</span>
              <span className="text-caption font-normal text-muted-foreground">v{props.appInfo.version}</span>
            </>
          }
        >
          <Button variant="secondary"
            onClick={disableUpdateCheck ? undefined : props.onCheckUpdate}
            // 禁用时不再显示 loading：检查可能已被禁用拦下，但状态未及落定时仍会转圈
            loading={props.updateChecking && !disableUpdateCheck}
            disabled={disableUpdateCheck}
          >
            {disableUpdateCheck
              ? t("settings.updateCheckDisabled")
              : t("settings.checkUpdate")}
          </Button>
        </SettingRow>
        <SettingSwitchRow
          title={t("settings.disableUpdateCheck")}
          description={t("settings.disableUpdateCheckDesc")}
          checked={draft.disableUpdateCheck}
          onChange={(checked) =>
            updateDraft({ disableUpdateCheck: checked })
          }
        />
      </SettingsSection>

      {/* 运行 */}
      <SettingsSection title={t("settings.sectionRuntime")}>
        <SettingRow
          title={
            <>
              <span>{t("settings.rpcTimeout")}</span>
              <DirtyMarker dirty={isDirty("rpcTimeout")} label={t("settings.rpcTimeout")} />
            </>
          }
          description={t("settings.rpcTimeoutDesc")}
          stacked
        >
          <Input
            type="number"
            className="max-w-80"
            value={String(Math.round(draft.rpcTimeout / 1000))}
            onChange={(e) => {
              const seconds = Math.max(600, parseInt(e.target.value) || 600);
              updateDraft({ rpcTimeout: seconds * 1000 });
            }}
          />
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.maxEditorFileSize")}</span>
              <DirtyMarker dirty={isDirty("maxEditorFileSizeMB")} label={t("settings.maxEditorFileSize")} />
            </>
          }
          description={t("settings.maxEditorFileSizeDesc")}
          stacked
        >
          <Input
            type="number"
            className="max-w-80"
            value={String(draft.maxEditorFileSizeMB)}
            onChange={(e) => {
              const mb = Math.max(1, parseInt(e.target.value) || 5);
              updateDraft({ maxEditorFileSizeMB: mb });
            }}
          />
        </SettingRow>
        <div className="px-0.5 pb-1 pt-3">
          <span className="text-caption font-semibold tracking-[0.06em] text-muted-foreground">{t("settings.piRpcStartup")}</span>
          <p className="mt-0.5 text-caption text-muted-foreground">{t("settings.piRpcStartupDesc")}</p>
        </div>
        <SettingSwitchRow
          title={t("settings.piRpcOffline")}
          description={t("settings.piRpcOfflineDesc")}
          checked={draft.piRpcOffline}
          onChange={(checked) => updateDraft({ piRpcOffline: checked })}
        />
        <SettingSwitchRow
          title={t("settings.piRpcNoExtensions")}
          description={t("settings.piRpcNoExtensionsDesc")}
          checked={draft.piRpcNoExtensions}
          onChange={(checked) => updateDraft({ piRpcNoExtensions: checked })}
        />
        <SettingSwitchRow
          title={t("settings.piRpcNoSkills")}
          description={t("settings.piRpcNoSkillsDesc")}
          checked={draft.piRpcNoSkills}
          onChange={(checked) => updateDraft({ piRpcNoSkills: checked })}
        />
      </SettingsSection>

      {/* Web 本地服务 */}
      <SettingsSection title={t("settings.webLocalService")} description={t("settings.webLocalServiceDesc")}>
        <SettingSwitchRow
          title={t("settings.enableWebService")}
          description={
            props.webServiceChanging
              ? t("settings.webOpening")
              : t("settings.webOffDesc")
          }
          checked={draft.webServiceEnabled}
          disabled={props.webServiceChanging}
          onChange={(checked) =>
            updateDraft({ webServiceEnabled: checked })
          }
        />
        <div className="mt-2.5 grid gap-2.5">
          {/* Web 服务地址：主机（只读）+ 端口（可编辑）；shadcn Input + Label，
              两列均分不再有主机列挤压/过宽问题，主机超长时 Input 内滚动 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0">
              <Label className="text-xs font-bold text-text-tertiary">{t("common.host")}</Label>
              <Input
                value={draft.webServiceHost}
                readOnly
                className="mt-1 font-mono text-sm tabular-nums"
              />
            </div>
            <div className="min-w-0">
              <Label className="text-xs font-bold text-text-tertiary">{t("common.port")}</Label>
              <Input
                type="number"
                min={1}
                max={65535}
                value={webPortDraft}
                disabled={props.webServiceChanging}
                className="mt-1 font-mono text-sm tabular-nums"
                onChange={(event) => setWebPortDraft(event.target.value)}
                onBlur={applyWebPortDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyWebPortDraft();
                    event.currentTarget.blur();
                  }
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border border-border-subtle/70 bg-bg-muted/30 px-3 py-2.5">
            {/* 服务状态点：开启时 accent 色 + 光晕，关闭时灰 */}
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                draft.webServiceEnabled
                  ? "bg-[var(--color-accent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
                  : "bg-text-tertiary shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-text-tertiary)_12%,transparent)]",
              )}
            />
            <div className="min-w-0">
              <strong className="block truncate text-caption font-semibold text-text-primary">
                http://127.0.0.1:{webPortDraft || draft.webServicePort}
              </strong>
              <small className="mt-0.5 block text-micro text-text-tertiary">{t("settings.localWebHint")}</small>
            </div>
            <Button variant="secondary"
              size="sm"
              disabled={!draft.webServiceEnabled}
              onClick={() =>
                props.onOpenWebService(webPortDraft || String(draft.webServicePort))
              }
            >
              {t("common.open")}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={!draft.webServiceEnabled || props.webServiceChanging}
              onClick={props.onRestartWebService}
            >
              <RotateCw className="mr-1.5 size-3.5" aria-hidden="true" />
              {props.webServiceChanging ? t("settings.webRestarting") : t("settings.webRestartService")}
            </Button>
          </div>
          <div className="grid gap-2 rounded-lg border border-border-subtle/70 bg-bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <strong className="block text-caption font-semibold text-text-primary">{t("settings.webQrTitle")}</strong>
                <small className="mt-0.5 block text-micro text-text-tertiary">{t("settings.webQrDesc")}</small>
              </div>
              {webNetworkLoading && <span className="text-micro text-text-tertiary">{t("settings.webNetworkLoading")}</span>}
            </div>
            {webNetworkAddresses.length > 0 ? (
              <div className="grid gap-1.5">
                <Label className="text-xs font-bold text-text-tertiary">{t("settings.webQrAddress")}</Label>
                <Select value={selectedWebAddress} onValueChange={setSelectedWebAddress}>
                  <SelectTrigger className="font-mono text-sm tabular-nums">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {webNetworkAddresses.map((item) => (
                      <SelectItem key={item.address} value={item.address}>
                        <span className="font-mono">{item.address}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{item.interfaceName}{item.cidr ? ` · /${item.cidr.split("/")[1]}` : ""}{item.isPrivate ? ` · ${t("settings.webLanAddress")}` : ""}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-caption text-text-tertiary">{t("settings.webNoNetworkAddress")}</p>
            )}
            {webQrDataUrl ? (
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <img src={webQrDataUrl} alt={t("settings.webQrAlt")} className="size-44 rounded-md bg-white p-2" />
                <div className="min-w-0 flex-1">
                  <code className="block break-all text-caption text-text-primary">{webAccessUrl}</code>
                  <small className="mt-1 block text-micro text-text-tertiary">{t("settings.webQrScanHint")}</small>
                </div>
              </div>
            ) : (
              <p className="text-caption text-text-tertiary">{draft.webServiceEnabled ? t("settings.webQrUnavailable") : t("settings.webQrEnableHint")}</p>
            )}
          </div>
        </div>
      </SettingsSection>

      {/* 外部编辑器（由 Pi 管理界面迁入） */}
      <SettingsSection
        title={
          <>
            <span>{t("settings.sectionEditors")}</span>
            <DirtyMarker dirty={isDirty("externalEditors")} label={t("settings.sectionEditors")} />
          </>
        }
      >
        <ExternalEditorsSection
          editors={draft.externalEditors}
          onChange={updateDraft}
        />
      </SettingsSection>

      {/* 调试 */}
      <SettingsSection title={t("settings.debug")}>
        <SettingRow
          title={<span>{t("settings.restartApp")}</span>}
          description={t("settings.restartAppDesc")}
        >
          <Button variant="secondary" onClick={props.onRestartApp}>
            {t("settings.restartAppButton")}
          </Button>
        </SettingRow>
        <SettingRow
          title={<span>{t("settings.devTools")}</span>}
          description={t("settings.devToolsDesc")}
        >
          <Button variant="secondary" onClick={props.onToggleDevTools}>
            {t("settings.toggle")}
          </Button>
        </SettingRow>
      </SettingsSection>

      
    </>
  );
});
