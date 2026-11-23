#include "UsageBuckets.h"

#include <QHash>
#include <QMap>
#include <QSet>

#include <algorithm>

namespace usage {
namespace {

/** model "provider/model" → provider（第一个 "/" 前部分，无 "/" 时整体视为 provider）。 */
QString providerOf(const QString &model)
{
    const qsizetype index = model.indexOf(QLatin1Char('/'));
    return index == -1 ? model : model.left(index);
}

QStringList sortedUnique(const QStringList &values)
{
    QStringList unique = values;
    unique.sort();
    unique.removeDuplicates();
    return unique;
}

QStringList unionOf(const QStringList &a, const QStringList &b)
{
    return sortedUnique(a + b);
}

void addToProvider(QHash<QString, ProviderSlice> *map, const QString &provider, const Record &record)
{
    ProviderSlice &slice = (*map)[provider];
    slice.provider = provider;
    slice.tokens += record.totalTokens;
    slice.turns += 1;
}

void addToDayModel(QHash<QString, DayModelSlice> *map, const Record &record)
{
    DayModelSlice &slice = (*map)[record.model];
    slice.model = record.model;
    slice.provider = providerOf(record.model);
    slice.tokens += record.totalTokens;
    slice.turns += 1;
}

void addToDayProject(QHash<QString, DayProjectSlice> *map, const Record &record)
{
    DayProjectSlice &slice = (*map)[record.cwd];
    slice.project = record.cwd;
    slice.tokens += record.totalTokens;
    slice.turns += 1;
}

template <typename T>
QVector<T> sortedByTokensDescending(const QHash<QString, T> &map)
{
    QVector<T> values;
    values.reserve(map.size());
    for (auto it = map.constBegin(); it != map.constEnd(); ++it) values.append(it.value());
    std::sort(values.begin(), values.end(), [](const T &a, const T &b) {
        if (a.tokens != b.tokens) return a.tokens > b.tokens;
        return false;
    });
    return values;
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
    merged.sessions = unionOf(a.sessions, b.sessions);
    return merged;
}

struct DayBucketAccumulator {
    DayTotals totals;
    QSet<QString> sessions;
    QHash<QString, ProviderSlice> byProvider;
    QHash<QString, DayModelSlice> byModel;
    QHash<QString, DayProjectSlice> byProject;
};

struct ModelAccumulator {
    QString provider;
    double tokens = 0;
    double turns = 0;
    QSet<QString> sessions;
};

struct ProjectAccumulator {
    double tokens = 0;
    double turns = 0;
    QSet<QString> sessions;
};

QStringList toSortedList(const QSet<QString> &values)
{
    QStringList list(values.constBegin(), values.constEnd());
    list.sort();
    return list;
}

/** 合并两个单日切片桶（增量合并用）。 */
template <typename T, typename KeyFn>
QVector<T> mergeSlices(const QVector<T> &base, const QVector<T> &delta, KeyFn keyOf)
{
    QHash<QString, T> merged;
    for (const T &slice : base) merged.insert(keyOf(slice), slice);
    for (const T &slice : delta) {
        const QString key = keyOf(slice);
        auto it = merged.find(key);
        if (it == merged.end()) {
            merged.insert(key, slice);
        } else {
            it->tokens += slice.tokens;
            it->turns += slice.turns;
        }
    }
    return sortedByTokensDescending(merged);
}

} // namespace

QString dayKeyOf(const QDateTime &moment)
{
    const QDate date = moment.date();
    return QStringLiteral("%1-%2-%3")
        .arg(date.year(), 4, 10, QLatin1Char('0'))
        .arg(date.month(), 2, 10, QLatin1Char('0'))
        .arg(date.day(), 2, 10, QLatin1Char('0'));
}

Intermediate intermediateFromRecords(const QVector<Record> &records)
{
    QMap<QString, DayBucketAccumulator> dayBuckets;
    QHash<QString, ModelAccumulator> byModel;
    QHash<QString, ProjectAccumulator> byProject;
    DayTotals totals;
    QSet<QString> totalSessions;
    double firstTs = 0;
    double lastTs = 0;
    bool hasWindow = false;

    for (const Record &record : records) {
        const QString dayKey = dayKeyOf(QDateTime::fromMSecsSinceEpoch(
            static_cast<qint64>(record.ts)));
        DayBucketAccumulator &bucket = dayBuckets[dayKey];
        bucket.totals.tokens += record.totalTokens;
        bucket.totals.input += record.input;
        bucket.totals.output += record.output;
        bucket.totals.cacheRead += record.cacheRead;
        bucket.totals.cacheWrite += record.cacheWrite;
        bucket.totals.turns += 1;
        bucket.sessions.insert(record.sid);
        addToProvider(&bucket.byProvider, providerOf(record.model), record);
        addToDayModel(&bucket.byModel, record);
        addToDayProject(&bucket.byProject, record);

        totals.tokens += record.totalTokens;
        totals.input += record.input;
        totals.output += record.output;
        totals.cacheRead += record.cacheRead;
        totals.cacheWrite += record.cacheWrite;
        totals.turns += 1;
        totalSessions.insert(record.sid);

        ModelAccumulator &modelRow = byModel[record.model];
        modelRow.provider = providerOf(record.model);
        modelRow.tokens += record.totalTokens;
        modelRow.turns += 1;
        modelRow.sessions.insert(record.sid);

        ProjectAccumulator &projectRow = byProject[record.cwd];
        projectRow.tokens += record.totalTokens;
        projectRow.turns += 1;
        projectRow.sessions.insert(record.sid);

        if (!hasWindow) {
            firstTs = record.ts;
            lastTs = record.ts;
            hasWindow = true;
        } else {
            firstTs = qMin(firstTs, record.ts);
            lastTs = qMax(lastTs, record.ts);
        }
    }

    Intermediate state;
    state.dayBuckets.reserve(dayBuckets.size());
    for (auto it = dayBuckets.constBegin(); it != dayBuckets.constEnd(); ++it) {
        DayBucket bucket;
        bucket.day = it.key();
        bucket.totals = it.value().totals;
        bucket.sessions = toSortedList(it.value().sessions);
        bucket.totals.sessions = bucket.sessions;
        bucket.byProvider = sortedByTokensDescending(it.value().byProvider);
        bucket.byModel = sortedByTokensDescending(it.value().byModel);
        bucket.byProject = sortedByTokensDescending(it.value().byProject);
        state.dayBuckets.append(bucket);
    }

    QVector<ModelBucket> modelBuckets;
    modelBuckets.reserve(byModel.size());
    for (auto it = byModel.constBegin(); it != byModel.constEnd(); ++it) {
        ModelBucket bucket;
        bucket.model = it.key();
        bucket.provider = it.value().provider;
        bucket.tokens = it.value().tokens;
        bucket.turns = it.value().turns;
        bucket.sessions = toSortedList(it.value().sessions);
        modelBuckets.append(bucket);
    }
    std::sort(modelBuckets.begin(), modelBuckets.end(),
              [](const ModelBucket &a, const ModelBucket &b) { return a.tokens > b.tokens; });
    state.modelBuckets = modelBuckets;

    QVector<ProjectBucket> projectBuckets;
    projectBuckets.reserve(byProject.size());
    for (auto it = byProject.constBegin(); it != byProject.constEnd(); ++it) {
        ProjectBucket bucket;
        bucket.project = it.key();
        bucket.tokens = it.value().tokens;
        bucket.turns = it.value().turns;
        bucket.sessions = toSortedList(it.value().sessions);
        projectBuckets.append(bucket);
    }
    std::sort(projectBuckets.begin(), projectBuckets.end(),
              [](const ProjectBucket &a, const ProjectBucket &b) { return a.tokens > b.tokens; });
    state.projectBuckets = projectBuckets;

    totals.sessions = toSortedList(totalSessions);
    state.totals = totals;
    state.windowSince = hasWindow ? firstTs : 0;
    state.windowTo = hasWindow ? lastTs : -1;
    state.recordCount = records.size();
    return state;
}

Intermediate mergeIntermediates(const Intermediate &base, const Intermediate &delta)
{
    // 空增量 = no-op：否则空态的 window {0,-1} 会污染 base。
    if (delta.recordCount == 0) return base;
    // 空 base = 直接取增量：否则空态 window.since=0 会被 min 拉低。
    if (base.recordCount == 0) return delta;

    QMap<QString, DayBucket> dayMap;
    for (const DayBucket &bucket : base.dayBuckets) dayMap.insert(bucket.day, bucket);
    for (const DayBucket &incoming : delta.dayBuckets) {
        auto it = dayMap.find(incoming.day);
        if (it == dayMap.end()) {
            dayMap.insert(incoming.day, incoming);
            continue;
        }
        DayBucket merged;
        merged.day = incoming.day;
        merged.totals = mergeTotals(it->totals, incoming.totals);
        merged.sessions = unionOf(it->sessions, incoming.sessions);
        merged.totals.sessions = merged.sessions;
        merged.byProvider = mergeSlices<ProviderSlice>(
            it->byProvider, incoming.byProvider,
            [](const ProviderSlice &slice) { return slice.provider; });
        merged.byModel = mergeSlices<DayModelSlice>(
            it->byModel, incoming.byModel,
            [](const DayModelSlice &slice) { return slice.model; });
        merged.byProject = mergeSlices<DayProjectSlice>(
            it->byProject, incoming.byProject,
            [](const DayProjectSlice &slice) { return slice.project; });
        *it = merged;
    }

    QHash<QString, ModelBucket> modelMap;
    for (const ModelBucket &bucket : base.modelBuckets) modelMap.insert(bucket.model, bucket);
    for (const ModelBucket &incoming : delta.modelBuckets) {
        auto it = modelMap.find(incoming.model);
        if (it == modelMap.end()) {
            modelMap.insert(incoming.model, incoming);
            continue;
        }
        it->tokens += incoming.tokens;
        it->turns += incoming.turns;
        it->sessions = unionOf(it->sessions, incoming.sessions);
    }

    QHash<QString, ProjectBucket> projectMap;
    for (const ProjectBucket &bucket : base.projectBuckets) projectMap.insert(bucket.project, bucket);
    for (const ProjectBucket &incoming : delta.projectBuckets) {
        auto it = projectMap.find(incoming.project);
        if (it == projectMap.end()) {
            projectMap.insert(incoming.project, incoming);
            continue;
        }
        it->tokens += incoming.tokens;
        it->turns += incoming.turns;
        it->sessions = unionOf(it->sessions, incoming.sessions);
    }

    Intermediate merged;
    merged.dayBuckets = QVector<DayBucket>(dayMap.constBegin(), dayMap.constEnd());
    merged.modelBuckets = sortedByTokensDescending(modelMap);
    merged.projectBuckets = sortedByTokensDescending(projectMap);
    merged.totals = mergeTotals(base.totals, delta.totals);
    merged.windowSince = qMin(base.windowSince, delta.windowSince);
    merged.windowTo = qMax(base.windowTo, delta.windowTo);
    merged.recordCount = base.recordCount + delta.recordCount;
    return merged;
}

} // namespace usage
