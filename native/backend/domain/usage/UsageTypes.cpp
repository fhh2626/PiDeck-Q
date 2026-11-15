#include "UsageTypes.h"

#include <QDir>
#include <QJsonValue>

namespace usage {
namespace {

QJsonArray toArray(const QStringList &values)
{
    QJsonArray array;
    for (const QString &value : values) array.append(value);
    return array;
}

QStringList toStringList(const QJsonValue &value)
{
    QStringList result;
    for (const QJsonValue &entry : value.toArray()) result.append(entry.toString());
    return result;
}

} // namespace

QJsonObject DayTotals::toJson() const
{
    return {
        {QStringLiteral("tokens"), tokens},
        {QStringLiteral("input"), input},
        {QStringLiteral("output"), output},
        {QStringLiteral("cacheRead"), cacheRead},
        {QStringLiteral("cacheWrite"), cacheWrite},
        {QStringLiteral("turns"), turns},
        {QStringLiteral("sessions"), toArray(sessions)},
    };
}

DayTotals DayTotals::fromJson(const QJsonObject &object)
{
    DayTotals totals;
    totals.tokens = object.value(QStringLiteral("tokens")).toDouble();
    totals.input = object.value(QStringLiteral("input")).toDouble();
    totals.output = object.value(QStringLiteral("output")).toDouble();
    totals.cacheRead = object.value(QStringLiteral("cacheRead")).toDouble();
    totals.cacheWrite = object.value(QStringLiteral("cacheWrite")).toDouble();
    totals.turns = object.value(QStringLiteral("turns")).toDouble();
    totals.sessions = toStringList(object.value(QStringLiteral("sessions")));
    return totals;
}

QJsonObject ProviderSlice::toJson() const
{
    return {
        {QStringLiteral("provider"), provider},
        {QStringLiteral("tokens"), tokens},
        {QStringLiteral("turns"), turns},
    };
}

ProviderSlice ProviderSlice::fromJson(const QJsonObject &object)
{
    ProviderSlice slice;
    slice.provider = object.value(QStringLiteral("provider")).toString();
    slice.tokens = object.value(QStringLiteral("tokens")).toDouble();
    slice.turns = object.value(QStringLiteral("turns")).toDouble();
    return slice;
}

QJsonObject DayModelSlice::toJson() const
{
    return {
        {QStringLiteral("model"), model},
        {QStringLiteral("provider"), provider},
        {QStringLiteral("tokens"), tokens},
        {QStringLiteral("turns"), turns},
    };
}

DayModelSlice DayModelSlice::fromJson(const QJsonObject &object)
{
    DayModelSlice slice;
    slice.model = object.value(QStringLiteral("model")).toString();
    slice.provider = object.value(QStringLiteral("provider")).toString();
    slice.tokens = object.value(QStringLiteral("tokens")).toDouble();
    slice.turns = object.value(QStringLiteral("turns")).toDouble();
    return slice;
}

QJsonObject DayProjectSlice::toJson() const
{
    return {
        {QStringLiteral("project"), project},
        {QStringLiteral("tokens"), tokens},
        {QStringLiteral("turns"), turns},
    };
}

DayProjectSlice DayProjectSlice::fromJson(const QJsonObject &object)
{
    DayProjectSlice slice;
    slice.project = object.value(QStringLiteral("project")).toString();
    slice.tokens = object.value(QStringLiteral("tokens")).toDouble();
    slice.turns = object.value(QStringLiteral("turns")).toDouble();
    return slice;
}

namespace {

template <typename T>
QJsonArray toObjectArray(const QVector<T> &values)
{
    QJsonArray array;
    for (const T &value : values) array.append(value.toJson());
    return array;
}

template <typename T>
QVector<T> fromObjectArray(const QJsonValue &value)
{
    QVector<T> result;
    const QJsonArray array = value.toArray();
    result.reserve(array.size());
    for (const QJsonValue &entry : array) result.append(T::fromJson(entry.toObject()));
    return result;
}

} // namespace

QJsonObject DayBucket::toJson() const
{
    return {
        {QStringLiteral("day"), day},
        {QStringLiteral("totals"), totals.toJson()},
        {QStringLiteral("sessions"), toArray(sessions)},
        {QStringLiteral("byProvider"), toObjectArray(byProvider)},
        {QStringLiteral("byModel"), toObjectArray(byModel)},
        {QStringLiteral("byProject"), toObjectArray(byProject)},
    };
}

DayBucket DayBucket::fromJson(const QJsonObject &object)
{
    DayBucket bucket;
    bucket.day = object.value(QStringLiteral("day")).toString();
    bucket.totals = DayTotals::fromJson(object.value(QStringLiteral("totals")).toObject());
    bucket.sessions = toStringList(object.value(QStringLiteral("sessions")));
    bucket.byProvider = fromObjectArray<ProviderSlice>(object.value(QStringLiteral("byProvider")));
    bucket.byModel = fromObjectArray<DayModelSlice>(object.value(QStringLiteral("byModel")));
    bucket.byProject = fromObjectArray<DayProjectSlice>(object.value(QStringLiteral("byProject")));
    return bucket;
}

QJsonObject ModelBucket::toJson() const
{
    return {
        {QStringLiteral("model"), model},
        {QStringLiteral("provider"), provider},
        {QStringLiteral("tokens"), tokens},
        {QStringLiteral("turns"), turns},
        {QStringLiteral("sessions"), toArray(sessions)},
    };
}

ModelBucket ModelBucket::fromJson(const QJsonObject &object)
{
    ModelBucket bucket;
    bucket.model = object.value(QStringLiteral("model")).toString();
    bucket.provider = object.value(QStringLiteral("provider")).toString();
    bucket.tokens = object.value(QStringLiteral("tokens")).toDouble();
    bucket.turns = object.value(QStringLiteral("turns")).toDouble();
    bucket.sessions = toStringList(object.value(QStringLiteral("sessions")));
    return bucket;
}

QJsonObject ProjectBucket::toJson() const
{
    return {
        {QStringLiteral("project"), project},
        {QStringLiteral("tokens"), tokens},
        {QStringLiteral("turns"), turns},
        {QStringLiteral("sessions"), toArray(sessions)},
    };
}

ProjectBucket ProjectBucket::fromJson(const QJsonObject &object)
{
    ProjectBucket bucket;
    bucket.project = object.value(QStringLiteral("project")).toString();
    bucket.tokens = object.value(QStringLiteral("tokens")).toDouble();
    bucket.turns = object.value(QStringLiteral("turns")).toDouble();
    bucket.sessions = toStringList(object.value(QStringLiteral("sessions")));
    return bucket;
}

QJsonObject Intermediate::toJson() const
{
    return {
        {QStringLiteral("dayBuckets"), toObjectArray(dayBuckets)},
        {QStringLiteral("modelBuckets"), toObjectArray(modelBuckets)},
        {QStringLiteral("projectBuckets"), toObjectArray(projectBuckets)},
        {QStringLiteral("totals"), totals.toJson()},
        {QStringLiteral("window"),
         QJsonObject{
             {QStringLiteral("since"), windowSince},
             {QStringLiteral("to"), windowTo},
         }},
        {QStringLiteral("recordCount"), recordCount},
    };
}

Intermediate Intermediate::fromJson(const QJsonObject &object)
{
    Intermediate state;
    state.dayBuckets = fromObjectArray<DayBucket>(object.value(QStringLiteral("dayBuckets")));
    state.modelBuckets = fromObjectArray<ModelBucket>(object.value(QStringLiteral("modelBuckets")));
    state.projectBuckets = fromObjectArray<ProjectBucket>(object.value(QStringLiteral("projectBuckets")));
    state.totals = DayTotals::fromJson(object.value(QStringLiteral("totals")).toObject());
    const QJsonObject window = object.value(QStringLiteral("window")).toObject();
    state.windowSince = window.value(QStringLiteral("since")).toDouble();
    state.windowTo = window.value(QStringLiteral("to")).toDouble(-1);
    state.recordCount = object.value(QStringLiteral("recordCount")).toInt();
    return state;
}

QString logPathFor(const QString &agentDir)
{
    return QDir(agentDir).filePath(QStringLiteral("analytics/usage.jsonl"));
}

} // namespace usage
