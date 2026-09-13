import type { AppSettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { DirtyMarker, SettingRow } from "./SettingRows";
import { SettingsSection } from "./SettingsStorageTab";

type TypographyLabelKey =
  | "settings.typographyCompact"
  | "settings.typographyDefault"
  | "settings.typographyRelaxed"
  | "settings.typographyLoose";

/**
 * 会话排版设置组：正文行距 / 内容块间距 / 列表密度 / 代码与表格密度。
 *
 * 只暴露离散档位（用户易理解），不暴露像素数值；档位 → CSS token 的映射
 * 统一收敛在 lib/chatTypography.ts，这里只做 UI 与草稿写入。
 * 默认档位 = 出厂观感，因此旧用户打开设置时四项都显示「标准」。
 */
type DensityValue = "compact" | "default" | "relaxed";
type LineHeightValue = "compact" | "default" | "relaxed" | "loose";

const densityOptions: Array<{ value: DensityValue; labelKey: TypographyLabelKey }> = [
  { value: "compact", labelKey: "settings.typographyCompact" },
  { value: "default", labelKey: "settings.typographyDefault" },
  { value: "relaxed", labelKey: "settings.typographyRelaxed" },
];

const lineHeightOptions: Array<{ value: LineHeightValue; labelKey: TypographyLabelKey }> = [
  { value: "compact", labelKey: "settings.typographyCompact" },
  { value: "default", labelKey: "settings.typographyDefault" },
  { value: "relaxed", labelKey: "settings.typographyRelaxed" },
  { value: "loose", labelKey: "settings.typographyLoose" },
];

function DensitySelect(props: {
  value: DensityValue;
  onChange: (value: DensityValue) => void;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(value) => props.onChange(value as DensityValue)}
    >
      <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {densityOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {t(option.labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LineHeightSelect(props: {
  value: LineHeightValue;
  onChange: (value: LineHeightValue) => void;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(value) => props.onChange(value as LineHeightValue)}
    >
      <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {lineHeightOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {t(option.labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ChatTypographySection(props: {
  settings: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
}) {
  const { settings, updateDraft, isDirty } = props;

  return (
    <SettingsSection title={t("settings.sectionChatTypography")} description={t("settings.sectionChatTypographyDesc")}>
      <SettingRow
        title={
          <>
            <span>{t("settings.chatBodyLineHeight")}</span>
            <DirtyMarker dirty={isDirty("chatBodyLineHeight")} label={t("settings.chatBodyLineHeight")} />
          </>
        }
        description={t("settings.chatBodyLineHeightDesc")}
        alignEnd={false}
      >
        <LineHeightSelect
          value={settings.chatBodyLineHeight}
          onChange={(value) => updateDraft({ chatBodyLineHeight: value })}
        />
      </SettingRow>

      <SettingRow
        title={
          <>
            <span>{t("settings.chatBlockGap")}</span>
            <DirtyMarker dirty={isDirty("chatBlockGap")} label={t("settings.chatBlockGap")} />
          </>
        }
        description={t("settings.chatBlockGapDesc")}
        alignEnd={false}
      >
        <DensitySelect
          value={settings.chatBlockGap}
          onChange={(value) => updateDraft({ chatBlockGap: value })}
        />
      </SettingRow>

      <SettingRow
        title={
          <>
            <span>{t("settings.chatListDensity")}</span>
            <DirtyMarker dirty={isDirty("chatListDensity")} label={t("settings.chatListDensity")} />
          </>
        }
        description={t("settings.chatListDensityDesc")}
        alignEnd={false}
      >
        <DensitySelect
          value={settings.chatListDensity}
          onChange={(value) => updateDraft({ chatListDensity: value })}
        />
      </SettingRow>

      <SettingRow
        title={
          <>
            <span>{t("settings.chatCodeDensity")}</span>
            <DirtyMarker dirty={isDirty("chatCodeDensity")} label={t("settings.chatCodeDensity")} />
          </>
        }
        description={t("settings.chatCodeDensityDesc")}
        alignEnd={false}
      >
        <DensitySelect
          value={settings.chatCodeDensity}
          onChange={(value) => updateDraft({ chatCodeDensity: value })}
        />
      </SettingRow>
    </SettingsSection>
  );
}
