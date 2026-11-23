#pragma once

/**
 * 用量统计的可序列化中间态与记录类型。
 *
 * 数据源是 pi-tracker 扩展写出的 `analytics/usage.jsonl`（append-only），属于外部
 * 插件产物，一律按不可信输入处理：坏行跳过并计数，不让单行脏数据打断整次扫描。
 *
 * 中间态（Intermediate）刻意保持可序列化：它同时是磁盘缓存的载荷，冷启动命中缓存
 * 时无需重扫日志。视图（today/周/月/热力图）不落盘，每次按 now 重建。
 */

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVector>

namespace usage {

/** 单条用量记录（对应 usage.jsonl 一行）。 */
struct Record {
    double ts = 0;
    QString sid;
    QString cwd;
    QString model;
    double input = 0;
    double output = 0;
    double cacheRead = 0;
    double cacheWrite = 0;
    double totalTokens = 0;
};

/** 单日/区间合计。 */
struct DayTotals {
    double tokens = 0;
    double input = 0;
    double output = 0;
    double cacheRead = 0;
    double cacheWrite = 0;
    double turns = 0;
    QStringList sessions;

    QJsonObject toJson() const;
    static DayTotals fromJson(const QJsonObject &object);
};

struct ProviderSlice {
    QString provider;
    double tokens = 0;
    double turns = 0;

    QJsonObject toJson() const;
    static ProviderSlice fromJson(const QJsonObject &object);
};

struct DayModelSlice {
    QString model;
    QString provider;
    double tokens = 0;
    double turns = 0;

    QJsonObject toJson() const;
    static DayModelSlice fromJson(const QJsonObject &object);
};

struct DayProjectSlice {
    QString project;
    double tokens = 0;
    double turns = 0;

    QJsonObject toJson() const;
    static DayProjectSlice fromJson(const QJsonObject &object);
};

struct DayBucket {
    QString day;
    DayTotals totals;
    QStringList sessions;
    QVector<ProviderSlice> byProvider;
    QVector<DayModelSlice> byModel;
    QVector<DayProjectSlice> byProject;

    QJsonObject toJson() const;
    static DayBucket fromJson(const QJsonObject &object);
};

struct ModelBucket {
    QString model;
    QString provider;
    double tokens = 0;
    double turns = 0;
    QStringList sessions;

    QJsonObject toJson() const;
    static ModelBucket fromJson(const QJsonObject &object);
};

struct ProjectBucket {
    QString project;
    double tokens = 0;
    double turns = 0;
    QStringList sessions;

    QJsonObject toJson() const;
    static ProjectBucket fromJson(const QJsonObject &object);
};

/** 可序列化中间态。 */
struct Intermediate {
    QVector<DayBucket> dayBuckets;
    QVector<ModelBucket> modelBuckets;
    QVector<ProjectBucket> projectBuckets;
    DayTotals totals;
    /** 首/末条记录 ts；空数据时 since=0、to=-1（since > to 表示空窗）。 */
    double windowSince = 0;
    double windowTo = -1;
    int recordCount = 0;

    QJsonObject toJson() const;
    static Intermediate fromJson(const QJsonObject &object);
};

/** 日志文件名与目录约定（agentDir/analytics/usage.jsonl）。 */
QString logPathFor(const QString &agentDir);

} // namespace usage
