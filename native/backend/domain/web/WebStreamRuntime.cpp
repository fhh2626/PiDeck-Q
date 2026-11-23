#include "WebStreamRuntime.h"

namespace webstream {
namespace {

/** "Still working (or starting)": the only states a stream may follow. */
bool isLive(const RuntimeInfo *runtime)
{
    return runtime && (runtime->status == QLatin1String("running")
                       || runtime->status == QLatin1String("starting"));
}

/** `observe` may pin `starting`; `dispatch` only pins a genuinely running turn. */
bool isObservable(Admission admission, const RuntimeInfo &runtime)
{
    return runtime.status == QLatin1String("running")
        || (admission == Admission::Observe && runtime.status == QLatin1String("starting"));
}

} // namespace

QJsonObject Target::toJson() const
{
    return QJsonObject{
        {QStringLiteral("sessionId"), sessionId},
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("runtimeGeneration"), runtimeGeneration},
    };
}

QVector<RuntimeInfo> readRuntimeInfos(const QJsonArray &runtimes)
{
    QVector<RuntimeInfo> items;
    items.reserve(runtimes.size());
    for (const QJsonValue &value : runtimes) {
        if (!value.isObject()) continue;
        const QJsonObject row = value.toObject();
        RuntimeInfo info;
        info.sessionId = row.value(QStringLiteral("sessionId")).toString();
        info.agentId = row.value(QStringLiteral("agentId")).toString();
        info.runtimeGeneration = row.value(QStringLiteral("runtimeGeneration")).toInt();
        info.status = row.value(QStringLiteral("status")).toString();
        if (info.sessionId.isEmpty() || info.agentId.isEmpty()) continue;
        items.append(info);
    }
    return items;
}

Reconcile reconcile(const Target *target, const RuntimeInfo *runtime, Admission admission)
{
    Reconcile result;
    if (!target) {
        // Nothing pinned yet: only a live execution may be adopted. A dispatch stream
        // stays open through the activation that precedes its prompt; an observe stream
        // has nothing to watch and must end instead of leaking the connection.
        if (!isLive(runtime) || !isObservable(admission, *runtime)) {
            result.finish = admission == Admission::Observe;
            return result;
        }
        result.hasTarget = true;
        result.target.sessionId = runtime->sessionId;
        result.target.agentId = runtime->agentId;
        result.target.runtimeGeneration = runtime->runtimeGeneration;
        return result;
    }
    result.hasTarget = true;
    result.target = *target;
    // A pinned run follows exactly one runtime identity. Idle/closed/error, a vanished
    // runtime and a replacement all finish it; the next run pins its own identity.
    const bool same = runtime && runtime->sessionId == target->sessionId
        && runtime->agentId == target->agentId
        && runtime->runtimeGeneration == target->runtimeGeneration;
    result.finish = !same || !isLive(runtime);
    return result;
}

} // namespace webstream
