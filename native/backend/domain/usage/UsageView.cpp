#include "UsageView.h"

#include <QHash>
#include <QJsonArray>
#include <QSet>
#include <QTimeZone>

#include "UsageBuckets.h"

namespace usage {
namespace {

constexpr int kHeatmapWeeks = 53;
constexpr int kHeatmapCells = kHeatmapWeeks * 7;

/** 固定阈值分档（跨天可比，与渲染层约定一致）。 */
int levelFor(double tokens)
{
    if (tokens <= 0) return 0;
    if (tokens < 100) return 1;
    if (tokens < 1000) return 2;
    if (tokens < 100000) return 3;
    return 4;
}

/** 本地时区当天零点。 */
QDateTime localMidnight(const QDateTime &moment)
{
    const QDate date = moment.date();
    return QDateTime(date, QTime(0, 0), moment.timeZone());
}

/** 本地时区周一起始。 */
QDateTime localWeekStart(const QDateTime &moment)
{
    QDateTime monday = localMidnight(moment);
    // Qt dayOfWeek(): 1 = Monday … 7 = Sunday
    monday = monday.addDays(1 - moment.date().dayOfWeek());
    return monday;
}

DayTotals emptyTotals()
{
    return DayTotals{};
}

DayTotals mergeTotals(const DayTotals &a, const DayTotals &b)
{
    DayTotals merged;
    merged.tokens = a.tokens + b.tokens;
    merged.input = a.input + b.input;
    merged.output = a.output + b.output;
    merged.cacheRead = a.cacheRead + b.cacheRead;
    merged.cacheWrite = a.cacheWrite + b.cacheWrite;
    merged.turns = a.turns + b.turns;
    QStringList sessions = a.sessions + b.sessions;
    sessions.sort();
    sessions.removeDuplicates();
    merged.sessions = sessions;
    return merged;
}

} // namespace

QJsonObject buildAggregatedView(const Intermediate &state, const QDateTime &now)
{
    QHash<QString, const DayBucket *> dayMap;
    for (const DayBucket &bucket : state.dayBuckets) dayMap.insert(bucket.day, &bucket);

    QJsonArray daily;
    int activeDays = 0;
    for (const DayBucket &bucket : state.dayBuckets) {
        if (bucket.totals.tokens > 0) activeDays += 1;
        QJsonArray byProvider;
        for (const ProviderSlice &slice : bucket.byProvider) byProvider.append(slice.toJson());
        QJsonArray byModel;
        for (const DayModelSlice &slice : bucket.byModel) byModel.append(slice.toJson());
        QJsonArray byProject;
        for (const DayProjectSlice &slice : bucket.byProject) byProject.append(slice.toJson());
        daily.append(QJsonObject{
            {QStringLiteral("day"), bucket.day},
            {QStringLiteral("totals"), bucket.totals.toJson()},
            {QStringLiteral("byProvider"), byProvider},
            {QStringLiteral("byModel"), byModel},
            {QStringLiteral("byProject"), byProject},
        });
    }

    // 热力图：以 now 所在周为最后一周，往前共 53 列。按日历步进而不是固定 24h
    // 毫秒步进，跨 DST 切换时才不会逐日漂移。
    const QDateTime lastWeekStart = localWeekStart(now);
    const QDateTime firstWeekStart = lastWeekStart.addDays(-(kHeatmapWeeks - 1) * 7);
    QJsonArray heatmap;
    QDateTime cursor = firstWeekStart;
    for (int i = 0; i < kHeatmapCells; ++i) {
        const DayBucket *bucket = dayMap.value(dayKeyOf(cursor), nullptr);
        const double tokens = bucket ? bucket->totals.tokens : 0;
        heatmap.append(QJsonObject{
            {QStringLiteral("tokens"), tokens},
            {QStringLiteral("turns"), bucket ? bucket->totals.turns : 0},
            {QStringLiteral("level"), levelFor(tokens)},
        });
        cursor = cursor.addDays(1);
    }

    const QString todayKey = dayKeyOf(now);
    const QString weekStartKey = dayKeyOf(lastWeekStart);
    const QString monthStartKey = dayKeyOf(QDateTime(
        QDate(now.date().year(), now.date().month(), 1), QTime(0, 0), now.timeZone()));

    const DayBucket *todayBucket = dayMap.value(todayKey, nullptr);
    DayTotals thisWeek = emptyTotals();
    DayTotals thisMonth = emptyTotals();
    for (const DayBucket &bucket : state.dayBuckets) {
        if (bucket.day >= weekStartKey) thisWeek = mergeTotals(thisWeek, bucket.totals);
        if (bucket.day >= monthStartKey) thisMonth = mergeTotals(thisMonth, bucket.totals);
    }

    QJsonArray byModel;
    for (const ModelBucket &row : state.modelBuckets) {
        byModel.append(QJsonObject{
            {QStringLiteral("model"), row.model},
            {QStringLiteral("provider"), row.provider},
            {QStringLiteral("tokens"), row.tokens},
            {QStringLiteral("turns"), row.turns},
            {QStringLiteral("sessions"), row.sessions.size()},
        });
    }
    QJsonArray byProject;
    for (const ProjectBucket &row : state.projectBuckets) {
        byProject.append(QJsonObject{
            {QStringLiteral("project"), row.project},
            {QStringLiteral("tokens"), row.tokens},
            {QStringLiteral("turns"), row.turns},
        });
    }

    return QJsonObject{
        {QStringLiteral("window"),
         QJsonObject{
             {QStringLiteral("since"), state.windowSince},
             {QStringLiteral("to"), state.windowTo},
         }},
        {QStringLiteral("totals"), state.totals.toJson()},
        {QStringLiteral("activeDays"), activeDays},
        {QStringLiteral("today"), (todayBucket ? todayBucket->totals : emptyTotals()).toJson()},
        {QStringLiteral("thisWeek"), thisWeek.toJson()},
        {QStringLiteral("thisMonth"), thisMonth.toJson()},
        {QStringLiteral("daily"), daily},
        {QStringLiteral("heatmap"), heatmap},
        {QStringLiteral("heatmapStart"), dayKeyOf(firstWeekStart)},
        {QStringLiteral("byModel"), byModel},
        {QStringLiteral("byProject"), byProject},
        {QStringLiteral("recordCount"), state.recordCount},
    };
}

} // namespace usage
