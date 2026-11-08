/**
 * 按天用量明细（今日概览 + 按天搜索）。
 *
 * 顶部工具栏：日期选择（日历单选）+「回今日」快捷；默认聚焦今日，当日数据最醒目。
 * 明细区：当日 3 卡（tokens/轮次/会话数）+ provider 堆叠条与图例 + 当日模型表 + 当日项目表。
 * 选中天无记录时显示空态（日历仍可继续选其他天）。
 *
 * 数据来自主进程聚合的 daily 行（UsageDayRow 已含 byModel/byProject 明细），
 * 无新 IPC 通道；样式走 Tailwind utility + 既有 usage-stats-* 语义 class。
 */

import { useMemo, useState } from "react";
import { CalendarIcon } from "lucide-react";
import { zhCN } from "date-fns/locale/zh-CN";
import { enUS } from "date-fns/locale/en-US";
import type { UsageDayRow } from "../../../../../shared/types";
import { getI18nLocale, t } from "../../../i18n";
import { Calendar } from "../../ui-shadcn/calendar";
import { Button } from "../../ui-shadcn/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui-shadcn/popover";
import { SettingsSection } from "../settings/SettingsStorageTab";
import { colorForProvider } from "./providerColors";
import { UsageTable } from "./UsageTable";
import { formatTokens } from "./format";

/** 本地时区日键 "YYYY-MM-DD"。 */
function dayKeyOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 日键 → 本地 Date（不能用 new Date("YYYY-MM-DD")——按 UTC 零点解析会偏移一天）。 */
function parseDayKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** 当日卡片（与 UsageStatsTab 的 SummaryCard 同构）。 */
function DayCard(props: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="usage-stats-card">
      <div className="usage-stats-card-label">{props.label}</div>
      <div className="usage-stats-card-value">{props.value}</div>
      {props.sub && <div className="usage-stats-card-sub">{props.sub}</div>}
    </div>
  );
}

/** 当日 provider 堆叠条：色块宽度 = tokens 占比，hover 显示 provider/tokens。 */
function ProviderBar(props: {
  providers: Array<{ provider: string; tokens: number }>;
}) {
  const { providers } = props;
  const total = providers.reduce((acc, p) => acc + p.tokens, 0);
  if (total <= 0) return null;
  return (
    <div
      className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-border-subtle"
      aria-label={t("usageStats.dayDetail.providers")}
    >
      {providers.map((p) => (
        <div
          key={p.provider}
          style={{
            width: `${Math.max(1, (p.tokens / total) * 100)}%`,
            backgroundColor: colorForProvider(p.provider),
          }}
          title={`${p.provider} · ${formatTokens(p.tokens)}`}
        />
      ))}
    </div>
  );
}

/** 当日 provider 图例（名称 + tokens，tokens 降序）。 */
function ProviderLegend(props: {
  providers: Array<{ provider: string; tokens: number }>;
}) {
  const { providers } = props;
  return (
    <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
      {providers.map((p) => (
        <li key={p.provider} className="flex items-center gap-1.5 text-xs text-text-secondary">
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: colorForProvider(p.provider) }}
            aria-hidden="true"
          />
          <span className="max-w-56 truncate">{p.provider}</span>
          <span className="tabular-nums text-muted-foreground">{formatTokens(p.tokens)}</span>
        </li>
      ))}
    </ul>
  );
}

export function UsageDayDetail(props: { rows: UsageDayRow[] }) {
  const { rows } = props;
  const today = dayKeyOf(new Date());
  const [selected, setSelected] = useState<string>(today);
  const locale = getI18nLocale() === "zh-CN" ? zhCN : enUS;
  const isToday = selected === today;

  const row = useMemo(() => rows.find((r) => r.day === selected), [rows, selected]);

  return (
    <SettingsSection
      divided
      boxed={false}
      title={
        isToday
          ? t("usageStats.dayDetail.titleToday")
          : t("usageStats.dayDetail.titleDay", { date: selected })
      }
    >
      {/* 按天搜索工具栏：日历单选 + 回今日 */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="justify-start font-normal">
              <CalendarIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {selected}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[320px] p-0" align="start">
            <Calendar
              mode="single"
              locale={locale}
              selected={parseDayKey(selected)}
              classNames={{ root: "w-full" }}
              onSelect={(date) => {
                if (date) setSelected(dayKeyOf(date));
              }}
            />
          </PopoverContent>
        </Popover>
        {!isToday && (
          <Button variant="ghost" size="sm" onClick={() => setSelected(today)}>
            {t("usageStats.dayDetail.backToday")}
          </Button>
        )}
      </div>

      {!row ? (
        <div className="usage-stats-hint">{t("usageStats.dayDetail.empty")}</div>
      ) : (
        <>
          <div className="usage-stats-cards">
            <DayCard
              label={t("usageStats.dayDetail.cards.tokens")}
              value={formatTokens(row.totals.tokens)}
            />
            <DayCard label={t("usageStats.dayDetail.cards.turns")} value={String(row.totals.turns)} />
            <DayCard
              label={t("usageStats.dayDetail.cards.sessions")}
              value={String(row.totals.sessions.length)}
            />
          </div>

          {row.byProvider.length > 1 && (
            <>
              <ProviderBar providers={row.byProvider} />
              <ProviderLegend providers={row.byProvider} />
            </>
          )}

          {/* 当日模型/项目明细：独立淡色块 + 小节标题，与下方累计表明确区分 */}
          <div className="mt-4 rounded-md border border-border-subtle bg-bg-panel px-3 py-2.5">
            <div className="grid gap-4 xl:grid-cols-2">
              <div>
                <h4 className="mb-1.5 text-caption font-semibold text-text-secondary">
                  {t("usageStats.dayDetail.modelsTitle")}
                </h4>
                <UsageTable
                  headers={[
                    t("usageStats.models.col.model"),
                    t("usageStats.models.col.tokens"),
                    t("usageStats.models.col.turns"),
                  ]}
                  rows={row.byModel.map((m) => [
                    m.model,
                    formatTokens(m.tokens),
                    String(m.turns),
                  ])}
                />
              </div>
              <div>
                <h4 className="mb-1.5 text-caption font-semibold text-text-secondary">
                  {t("usageStats.dayDetail.projectsTitle")}
                </h4>
                <UsageTable
                  headers={[
                    t("usageStats.projects.col.project"),
                    t("usageStats.models.col.tokens"),
                    t("usageStats.models.col.turns"),
                  ]}
                  rows={row.byProject.map((p) => [
                    p.project,
                    formatTokens(p.tokens),
                    String(p.turns),
                  ])}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
