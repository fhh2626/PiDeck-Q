import { memo } from "react";
import type { AppSettings, AvailableModel } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui-shadcn/select";
import { ModelPicker } from "../../session/ComposerComponents";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingBox, SettingRow, SettingSwitchRow, SettingTextarea } from "./SettingRows";

type CommonTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
  gitModels: AvailableModel[];
  gitModelPickerOpen: boolean;
  onOpenGitModelPicker: () => void;
  onCloseGitModelPicker: () => void;
  onPickGitModel: (model: AvailableModel) => void;
  onToggleGitModelFavorite: (provider: string, modelId: string) => void;
};

/** 下拉选项：disabled 可选（SelectItem 透传） */
type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 设置弹框「常用设置」tab：语言/会话/通知/窗口/Git 分区。
 * 独立组件 + memo：切换 tab 或壳层无关状态变化时不重渲染本 tab。
 */
export const CommonTab = memo(function CommonTab(props: CommonTabProps) {
  const { draft, updateDraft, isDirty } = props;
  const languageOptions: SelectOption[] = [
    { value: "system", label: t("settings.languageSystem") },
    { value: "zh-CN", label: t("settings.languageZh") },
    { value: "en-US", label: t("settings.languageEn") },
    { value: "pseudo", label: t("settings.languagePseudo") },
  ];
  const sendShortcutOptions: SelectOption[] = [
    { value: "enter-send", label: t("settings.sendShortcut.enter") },
    { value: "ctrl-enter-send", label: t("settings.sendShortcut.ctrl") },
    { value: "shift-enter-send", label: t("settings.sendShortcut.shift") },
  ];
  const workspaceContentOpenModeOptions: SelectOption[] = [
    { value: "split", label: t("settings.workspaceContentOpenMode.split") },
    { value: "maximize", label: t("settings.workspaceContentOpenMode.maximize") },
  ];
  const startupWindowModeOptions: SelectOption[] = [
    { value: "last", label: t("settings.startupWindow.last") },
    { value: "maximized", label: t("settings.startupWindow.maximized") },
    { value: "normal-large", label: t("settings.startupWindow.large") },
    { value: "normal-medium", label: t("settings.startupWindow.medium") },
    { value: "normal-compact", label: t("settings.startupWindow.compact") },
    { value: "fullscreen", label: t("settings.startupWindow.fullscreen") },
  ];

  return (
    <>
      {/* 语言（单行分区：行标题即一级标题，内容行入淡色框） */}
      <SettingBox>
        <SettingRow
          level={1}
          title={
            <>
              <span>{t("settings.language")}</span>
              <DirtyMarker dirty={isDirty("language")} label={t("settings.language")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.language} onValueChange={(value) =>
              updateDraft({ language: value as AppSettings["language"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {languageOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingBox>

      {/* 会话 */}
      <SettingsSection title={t("settings.sectionSession")}>
        <SettingRow
          title={
            <>
              <span>{t("settings.sessionTabOpenMode")}</span>
              <DirtyMarker dirty={isDirty("sessionTabOpenMode")} label={t("settings.sessionTabOpenMode")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.sessionTabOpenMode} onValueChange={(value) =>
              updateDraft({ sessionTabOpenMode: value as AppSettings["sessionTabOpenMode"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="preview">{t("settings.sessionTabOpenModePreview")}</SelectItem>
              <SelectItem value="permanent">{t("settings.sessionTabOpenModePermanent")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.inputShortcut")}</span>
              <DirtyMarker dirty={isDirty("sendShortcut")} label={t("settings.inputShortcut")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.sendShortcut} onValueChange={(value) =>
              updateDraft({ sendShortcut: value as AppSettings["sendShortcut"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {sendShortcutOptions.map((option) => (
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
              <span>{t("settings.workspaceContentOpenMode")}</span>
              <DirtyMarker dirty={isDirty("workspaceContentOpenMode")} label={t("settings.workspaceContentOpenMode")} />
            </>
          }
          description={t("settings.workspaceContentOpenModeDesc")}
          alignEnd={false}
        >
          <Select
            value={draft.workspaceContentOpenMode ?? "split"}
            onValueChange={(value) =>
              updateDraft({
                workspaceContentOpenMode: value as AppSettings["workspaceContentOpenMode"],
              })
            }
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {workspaceContentOpenModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {/* 流式对话设置：省渲染资源的两个行为开关（默认值见 SettingsStore）。 */}
        <SettingSwitchRow
          title={t("settings.expandInterimDuringStream")}
          description={t("settings.expandInterimDuringStreamDesc")}
          checked={draft.expandInterimDuringStream}
          onChange={(checked) => updateDraft({ expandInterimDuringStream: checked })}
        />
        <SettingSwitchRow
          title={t("settings.collapsePrevRunsOnNewTurn")}
          description={t("settings.collapsePrevRunsOnNewTurnDesc")}
          checked={draft.collapsePrevRunsOnNewTurn}
          onChange={(checked) => updateDraft({ collapsePrevRunsOnNewTurn: checked })}
        />
      </SettingsSection>

      {/* 通知 */}
      <SettingsSection title={t("settings.notificationSection")}>
        <SettingSwitchRow
          title={t("settings.enableNotifications")}
          checked={draft.enableNotifications}
          onChange={(checked) =>
            updateDraft({ enableNotifications: checked })
          }
        />
        <SettingSwitchRow
          title={t("settings.agentCountReminder")}
          description={t("settings.agentCountReminderDesc")}
          checked={draft.agentCountReminderEnabled}
          onChange={(checked) =>
            updateDraft({ agentCountReminderEnabled: checked })
          }
        />
      </SettingsSection>

      {/* 窗口 */}
      <SettingsSection title={t("settings.sectionWindow")}>
        <SettingRow
          title={
            <>
              <span>{t("settings.startupWindowMode")}</span>
              <DirtyMarker
                dirty={isDirty("startupWindowMode")}
                label={t("settings.startupWindowMode")}
              />
            </>
          }
          description={t("settings.startupWindowModeDesc")}
          alignEnd={false}
        >
          <Select value={draft.startupWindowMode} onValueChange={(value) =>
              updateDraft({
                startupWindowMode: value as AppSettings["startupWindowMode"],
              })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {startupWindowModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingSwitchRow
          title={t("settings.closeToTray")}
          checked={draft.closeToTray}
          onChange={(checked) =>
            updateDraft({ closeToTray: checked })
          }
        />
        <SettingSwitchRow
          title={t("settings.singleInstance")}
          description={t("settings.singleInstanceDesc")}
          checked={draft.singleInstance}
          onChange={(checked) =>
            updateDraft({ singleInstance: checked })
          }
        />
      </SettingsSection>

      {/* Git */}
      <SettingsSection title={t("settings.git")}>
        <SettingSwitchRow
          title={t("settings.gitManagement")}
          description={t("settings.gitManagementDesc")}
          checked={draft.enableGitManagement}
          onChange={(checked) =>
            updateDraft({ enableGitManagement: checked })
          }
        />
        {draft.enableGitManagement && (
          <>
            <SettingRow
              title={
                <>
                  <span>{t("settings.gitCommitMessageModel")}</span>
                  <DirtyMarker dirty={isDirty("gitCommitMessageProvider") || isDirty("gitCommitMessageModel")} label={t("settings.gitCommitMessageModel")} />
                </>
              }
              description={t("settings.gitCommitMessageModelDesc")}
            >
              <Button
                variant="outline"
                className="w-full justify-start font-mono text-xs"
                onClick={props.onOpenGitModelPicker}
              >
                {draft.gitCommitMessageProvider && draft.gitCommitMessageModel
                  ? `${draft.gitCommitMessageProvider}/${draft.gitCommitMessageModel}`
                  : t("settings.gitCommitMessageModelUnset")}
              </Button>
            </SettingRow>
            <SettingTextarea
              title={t("settings.gitCommitMessagePrompt")}
              description={t("settings.gitCommitMessagePromptDesc")}
              value={draft.gitCommitMessagePrompt}
              onChange={(value) => updateDraft({ gitCommitMessagePrompt: value })}
            />
            {props.gitModelPickerOpen && (
              <ModelPicker
                models={props.gitModels}
                current={{
                  provider: draft.gitCommitMessageProvider,
                  modelId: draft.gitCommitMessageModel,
                }}
                favoriteModels={draft.favoriteModels ?? []}
                onClose={props.onCloseGitModelPicker}
                onPick={props.onPickGitModel}
                onToggleFavorite={props.onToggleGitModelFavorite}
              />
            )}
          </>
        )}
      </SettingsSection>
    </>
  );
});
