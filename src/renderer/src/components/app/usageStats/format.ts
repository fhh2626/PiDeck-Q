/**
 * 用量统计展示格式化（纯函数，供 Tab 与图表组件共用，避免循环 import）。
 */

/** 数字格式化：K/M/B 后缀（统计场景短格式）。 */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 日键（YYYY-MM-DD 本地时区）+ 天数偏移 → 本地日期字符串（工具提示用）。 */
export function formatDayKeyPlusOffset(dayKey: string, offsetDays: number): string {
  const d = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dayKey;
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
