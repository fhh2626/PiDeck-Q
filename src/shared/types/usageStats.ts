/**
 * 用量统计（Usage Stats）跨进程 DTO。
 *
 * 数据源：pi-tracker 扩展写入的 usage.jsonl（append-only）。
 * PiDeck 只读数据做展示，不承担采集职责（扩展机制：装插件=开功能）。
 *
 * 注意：IPC 结构化克隆不支持 Set，聚合内部可用 Set，跨层 DTO 一律用数组。
 */

/** 单条用量记录（对应 usage.jsonl 一行，位置数组 10/11 字段）。 */
export type UsageRecord = {
	/** Unix ms */
	ts: number;
	/** 会话 id */
	sid: string;
	/** pi 进程 cwd */
	cwd: string;
	/** "provider/model" */
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

/** 检测结果：pi-tracker 是否已装、日志是否可读。 */
export type UsageStatsDetectResult = {
	/** analytics/usage.jsonl 存在 */
	installed: boolean;
	/** host 路径（诊断/展示用），未安装为 null */
	logPath: string | null;
	/** 已解析记录数（缓存的 count），未知为 null */
	recordCount: number | null;
	/** 首条记录时间戳（ms），无数据为 null */
	firstRecordAt: number | null;
	/** 末条记录时间戳（ms），无数据为 null */
	lastRecordAt: number | null;
};

/** 刷新结果（增量解析统计）。 */
export type UsageStatsRefreshResult = {
	/** 本次是否全量重扫（文件变小/重写/首次） */
	fullRescan: boolean;
	/** 本次新解析出的记录数 */
	parsedRecords: number;
	/** 坏行数（JSON 解析失败/结构非法） */
	skippedLines: number;
};

/** 一个 provider 在某天的用量切片（堆叠柱用）。 */
export type ProviderSlice = {
	provider: string;
	tokens: number;
	turns: number;
};

/** 单日合计。 */
export type DayTotals = {
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	/** 当天有记录的会话 id 列表（去重） */
	sessions: string[];
};

/** 单日某模型切片（按天明细表用）。 */
export type UsageDayModelSlice = {
	model: string;
	provider: string;
	tokens: number;
	turns: number;
};

/** 单日某项目切片（按天明细表用）。 */
export type UsageDayProjectSlice = {
	project: string;
	tokens: number;
	turns: number;
};

/** 某天用量行（含 provider 分解与模型/项目明细）。 */
export type UsageDayRow = {
	/** "YYYY-MM-DD" 本地时区 */
	day: string;
	totals: DayTotals;
	byProvider: ProviderSlice[];
	/** 当日模型明细（tokens 降序） */
	byModel: UsageDayModelSlice[];
	/** 当日项目明细（tokens 降序） */
	byProject: UsageDayProjectSlice[];
};

/** 热力图格子（52 周 × 7 天，周一起始，含空天）。 */
export type HeatmapCell = {
	tokens: number;
	turns: number;
	/** 0-4 档色阶（由聚合器按阈值计算，跨天可比） */
	level: 0 | 1 | 2 | 3 | 4;
};

/** 模型用量排行行。 */
export type UsageModelRow = {
	model: string;
	provider: string;
	tokens: number;
	turns: number;
	sessions: number;
};

/** 项目用量排行行。 */
export type UsageProjectRow = {
	/** 完整 cwd 路径 */
	project: string;
	tokens: number;
	turns: number;
};

/** 聚合视图（主进程聚合后整体发给渲染层，渲染层不接触原始日志）。 */
export type UsageAggregated = {
	/** 数据覆盖时间窗（首/末条记录 ts；空数据时 since > to） */
	window: { since: number; to: number };
	totals: DayTotals;
	/** tokens > 0 的天数 */
	activeDays: number;
	today: DayTotals;
	thisWeek: DayTotals;
	thisMonth: DayTotals;
	/** 升序，仅含有效天（前端补齐空天） */
	daily: UsageDayRow[];
	/** 53 列 × 7 行（周一起始），index = week * 7 + dayIndex */
	heatmap: HeatmapCell[];
	/** 热力图首格日键（YYYY-MM-DD 本地时区）；渲染层 tooltip/日期锚点唯一来源 */
	heatmapStart: string;
	byModel: UsageModelRow[];
	byProject: UsageProjectRow[];
	/** 参与聚合的记录条数 */
	recordCount: number;
};
