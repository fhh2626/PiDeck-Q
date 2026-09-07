import { ChatTypographySection } from './ChatTypographySection';
import { memo } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi, isNativeRuntime } from "../../../desktopApi";
import { ACCENT_PRESETS } from "../../../themePresets";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingRow, SettingSwitchRow } from "./SettingRows";
import { Minus, Plus } from "lucide-react";

const ZOOM_FACTOR_MIN = 0.8;
const ZOOM_FACTOR_MAX = 1.5;
const ZOOM_FACTOR_STEP = 0.05;

type AppearanceTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
  /** 是否启用了分区字号（任一区域字号非空） */
  perAreaFontSize: boolean;
  setPerAreaFontSize: (checked: boolean) => void;
  platform: NodeJS.Platform;
};

/** 下拉选项：disabled 可选（SelectItem 透传） */
type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 设置弹框「外观设置」tab：主题/背景/字体/聊天排版/窗口样式。
 * 独立组件 + memo：切换 tab 或壳层无关状态变化时不重渲染本 tab。
 */
export const AppearanceTab = memo(function AppearanceTab(props: AppearanceTabProps) {
  const { draft, updateDraft, isDirty } = props;
  const nativeTitleBarRequired = isNativeRuntime && props.platform === "darwin";
  const themeOptions: SelectOption[] = [
    { value: "system", label: t("settings.themeSystem") },
    { value: "light", label: t("settings.themeLight") },
    { value: "dark", label: t("settings.themeDark") },
  ];
  // 主题色预设来自 themePresets.ts；新增自定义主题 = 扩展色板后这里自动出现
  const accentOptions: SelectOption[] = ACCENT_PRESETS.map((preset) => ({
    value: preset.id,
    label: t(preset.labelKey),
  }));
  const fontSizeOptions: SelectOption[] = [
    { value: "compact", label: t("settings.fontSizeCompact") },
    { value: "default", label: t("settings.fontSizeDefault") },
    { value: "medium", label: t("settings.fontSizeMedium") },
    { value: "large", label: t("settings.fontSizeLarge") },
    { value: "xlarge", label: t("settings.fontSizeXlarge") },
  ];
  const fontBaseOptions: SelectOption[] = [
    { value: "system", label: t("settings.fontFamilyBaseSystem") },
    { value: "sans", label: t("settings.fontFamilyBaseSans") },
    { value: "serif", label: t("settings.fontFamilyBaseSerif") },
    { value: "custom", label: t("settings.fontCustomOption") },
  ];
  const fontMonoOptions: SelectOption[] = [
    { value: "system-mono", label: t("settings.fontFamilyMonoSystemMono") },
    { value: "custom", label: t("settings.fontCustomOption") },
  ];

  const changeZoomFactor = (delta: number) => {
    const next = Math.min(
      ZOOM_FACTOR_MAX,
      Math.max(
        ZOOM_FACTOR_MIN,
        Math.round((draft.zoomFactor + delta) * 100) / 100,
      ),
    );
    updateDraft({ zoomFactor: next });
  };

  return (
    <>
      {/* 主题与背景 */}
      <SettingsSection title={t("settings.sectionThemeBackground")}>
        <SettingRow
          title={
            <>
              <span>{t("settings.theme")}</span>
              <DirtyMarker dirty={isDirty("theme")} label={t("settings.theme")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.theme} onValueChange={(value) =>
              updateDraft({ theme: value as AppSettings["theme"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {themeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.accent")}</span>
              <DirtyMarker dirty={isDirty("accent")} label={t("settings.accent")} />
            </>
          }
          description={t("settings.accentDesc")}
          alignEnd={false}
        >
          <Select value={draft.accent} onValueChange={(value) =>
              updateDraft({ accent: value as AppSettings["accent"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {accentOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {/* 背景图片：pideck-bg:// 协议加载 userData/backgrounds/ 下文件 */}
        <SettingRow
          title={
            <>
              <span>{t("settings.backgroundImage")}</span>
              <DirtyMarker dirty={isDirty("backgroundImage") || isDirty("backgroundImageOpacity")} label={t("settings.backgroundImage")} />
            </>
          }
          description={t("settings.backgroundImageDesc")}
        >
          <div className="flex items-center gap-2">
            {draft.backgroundImage ? (
              <img
                src={`pideck-bg://local/${encodeURIComponent(draft.backgroundImage)}`}
                alt=""
                className="h-12 w-20 shrink-0 rounded-sm border border-border object-cover"
              />
            ) : (
              <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-sm border border-dashed border-border text-[11px] text-muted-foreground">—</div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const name = await desktopApi.dialog.pickBackgroundImage();
                if (name) updateDraft({ backgroundImage: name });
              }}
            >
              {t("settings.backgroundImageChoose")}
            </Button>
            {draft.backgroundImage ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const name = draft.backgroundImage;
                  updateDraft({ backgroundImage: "" });
                  if (name) void desktopApi.dialog.removeBackgroundImage(name);
                }}
              >
                {t("settings.backgroundImageClear")}
              </Button>
            ) : null}
          </div>
        </SettingRow>
        <SettingRow
          title={<span>{t("settings.backgroundImageOpacity")}</span>}
        >
          <div className="flex w-full items-center gap-2">
            <input
              type="range"
              min={0}
              max={100}
              // 滑块与存储同语义=图片可见度（100%=图全显，0%=全遮罩），不再反转
              value={Math.round((draft.backgroundImageOpacity ?? 0.8) * 100)}
              onChange={(event) =>
                updateDraft({ backgroundImageOpacity: Number(event.target.value) / 100 })
              }
              className="h-4 min-w-0 flex-1 accent-[var(--color-accent)]"
              aria-label={t("settings.backgroundImageOpacity")}
            />
            <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{Math.round((draft.backgroundImageOpacity ?? 0.8) * 100)}%</span>
          </div>
        </SettingRow>
      </SettingsSection>

      {/* 字体 */}
      <SettingsSection title={t("settings.sectionFonts")}>
        {/* 窗口缩放：与字号设置同分组，避免「字变大」两个入口分散在不同分组；
           提示文案说明其与字号档位的区别（缩放=整体，字号=仅文字）。 */}
        <SettingRow
          title={
            <>
              <span>{t("settings.zoomFactor")}</span>
              <DirtyMarker dirty={isDirty("zoomFactor")} label={t("settings.zoomFactor")} />
            </>
          }
          description={t("settings.zoomFactorHint")}
        >
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-[6px] border border-border-subtle bg-bg-panel text-text-secondary hover:border-[var(--color-accent)] hover:bg-bg-active hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={draft.zoomFactor <= ZOOM_FACTOR_MIN}
              onClick={() => changeZoomFactor(-ZOOM_FACTOR_STEP)}
              aria-label={t("settings.zoomOut")}
              title={t("settings.zoomOut")}
            >
              <Minus size={16} strokeWidth={2.2} aria-hidden="true" />
            </Button>
            <output
              className="min-w-8 text-center font-brand text-control font-semibold text-foreground"
              aria-live="polite"
            >
              {Math.round(draft.zoomFactor * 100)}%
            </output>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-[6px] border border-border-subtle bg-bg-panel text-text-secondary hover:border-[var(--color-accent)] hover:bg-bg-active hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={draft.zoomFactor >= ZOOM_FACTOR_MAX}
              aria-label={t("settings.zoomIn")}
              title={t("settings.zoomIn")}
              onClick={() => changeZoomFactor(ZOOM_FACTOR_STEP)}
            >
              <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.fontSize")}</span>
              <DirtyMarker dirty={isDirty("fontSize")} label={t("settings.fontSize")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.fontSize} onValueChange={(value) =>
              updateDraft({ fontSize: value as AppSettings["fontSize"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {fontSizeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingSwitchRow
          title={t("settings.fontSizePerArea")}
          description={t("settings.fontSizePerAreaDesc")}
          checked={props.perAreaFontSize}
          onChange={(checked) => {
            props.setPerAreaFontSize(checked);
            if (!checked) {
              updateDraft({ uiFontSize: null, chatFontSize: null, inputFontSize: null });
            }
          }}
        />
        {props.perAreaFontSize && (
          <>
            <SettingRow
              title={
                <>
                  <span>{t("settings.uiFontSize")}</span>
                  <DirtyMarker dirty={isDirty("uiFontSize")} label={t("settings.uiFontSize")} />
                </>
              }
              alignEnd={false}
            >
              <Select value={draft.uiFontSize ?? draft.fontSize} onValueChange={(value) =>
                  updateDraft({ uiFontSize: value as AppSettings["uiFontSize"] })
                }>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {fontSizeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow
              title={
                <>
                  <span>{t("settings.chatFontSize")}</span>
                  <DirtyMarker dirty={isDirty("chatFontSize")} label={t("settings.chatFontSize")} />
                </>
              }
              alignEnd={false}
            >
              <Select value={draft.chatFontSize ?? draft.fontSize} onValueChange={(value) =>
                  updateDraft({ chatFontSize: value as AppSettings["chatFontSize"] })
                }>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {fontSizeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow
              title={
                <>
                  <span>{t("settings.inputFontSize")}</span>
                  <DirtyMarker dirty={isDirty("inputFontSize")} label={t("settings.inputFontSize")} />
                </>
              }
              alignEnd={false}
            >
              <Select value={draft.inputFontSize ?? draft.fontSize} onValueChange={(value) =>
                  updateDraft({ inputFontSize: value as AppSettings["inputFontSize"] })
                }>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {fontSizeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </>
        )}
        <SettingRow
          title={
            <>
              <span>{t("settings.fontFamilyBase")}</span>
              <DirtyMarker dirty={isDirty("fontFamilyBase")} label={t("settings.fontFamilyBase")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.fontFamilyBase} onValueChange={(value) =>
              updateDraft({ fontFamilyBase: value as AppSettings["fontFamilyBase"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {fontBaseOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {draft.fontFamilyBase === "custom" && (
          <SettingRow
            title={<span>{t("settings.fontFamilyBaseCustomField")}</span>}
            stacked
          >
            <Input type="text" value={draft.fontFamilyBaseCustom} placeholder={t("settings.fontFamilyBaseCustomPlaceholder")} onChange={(event) => updateDraft({ fontFamilyBaseCustom: event.target.value })} />
          </SettingRow>
        )}
        <SettingRow
          title={
            <>
              <span>{t("settings.fontFamilyMono")}</span>
              <DirtyMarker dirty={isDirty("fontFamilyMono")} label={t("settings.fontFamilyMono")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.fontFamilyMono} onValueChange={(value) =>
              updateDraft({ fontFamilyMono: value as AppSettings["fontFamilyMono"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {fontMonoOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {draft.fontFamilyMono === "custom" && (
          <SettingRow
            title={<span>{t("settings.fontFamilyMonoCustomField")}</span>}
            stacked
          >
            <Input type="text" value={draft.fontFamilyMonoCustom} placeholder={t("settings.fontFamilyMonoCustomPlaceholder")} onChange={(event) => updateDraft({ fontFamilyMonoCustom: event.target.value })} />
          </SettingRow>
        )}
      </SettingsSection>

      {/* 聊天排版 */}
      <SettingsSection title={t("settings.sectionChatLayout")}>
        <SettingRow
          title={<span>{t("settings.contentWidthPct")}</span>}
          description={t("settings.contentWidthPctDesc")}
        >
          <div className="flex w-full items-center gap-2">
            <input
              type="range"
              min="60"
              max="100"
              step="1"
              value={draft.chatContentWidthPct}
              onChange={(event) => updateDraft({ chatContentWidthPct: parseInt(event.target.value) })}
              className="min-w-0 flex-1 accent-[var(--color-accent)]"
              aria-label={t("settings.contentWidthPct")}
            />
            <span className="min-w-8 shrink-0 text-right font-brand text-sm text-muted-foreground tabular-nums">
              {draft.chatContentWidthPct}%
            </span>
          </div>
        </SettingRow>
      </SettingsSection>

      {/* 窗口样式 */}
      <SettingsSection title={t("settings.sectionWindowStyle")}>
        <SettingSwitchRow
          title={t("settings.nativeTitleBar")}
          description={nativeTitleBarRequired ? t("settings.nativeTitleBarMacDesc") : undefined}
          checked={nativeTitleBarRequired || draft.useNativeTitleBar}
          disabled={nativeTitleBarRequired}
          onChange={(checked) =>
            updateDraft({ useNativeTitleBar: checked })
          }
        />
        <SettingSwitchRow
          title={t("settings.nativeMenu")}
          checked={draft.showNativeMenu}
          onChange={(checked) =>
            updateDraft({ showNativeMenu: checked })
          }
        />
      </SettingsSection>

      <ChatTypographySection settings={draft} updateDraft={updateDraft} isDirty={isDirty} />
    </>
  );
});
