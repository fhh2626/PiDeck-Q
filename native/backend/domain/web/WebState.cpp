#include "WebState.h"

#include "RuntimeCoordinator.h"
#include "SessionCatalogStore.h"
#include "ProjectStore.h"

#include <QJsonArray>
#include <QSet>

namespace webstate {
namespace {

/**
 * A record that is child work rather than a top-level web session.
 *
 * Mirrors `WebServiceManager.getState()`: internal subagents, Codex subagent rollouts and
 * parent-marked records are all hidden. A Codex subagent rollout reaches the catalog as an
 * ordinary pi session (the `codex_import` marker only carries metadata), so it has to be
 * excluded by `codexThreadSource` explicitly, not by the parent marker.
 */
bool isVisibleRecord(const QJsonObject &record)
{
    if (record.value(QStringLiteral("isInternalSubagent")).toBool()) return false;
    if (record.value(QStringLiteral("codexThreadSource")).toString() == QLatin1String("subagent")) {
        return false;
    }
    if (record.contains(QStringLiteral("parentSessionPath"))) return false;
    return true;
}

} // namespace

QJsonObject build(const ChannelServices &services)
{
    QJsonObject state;
    state.insert(QStringLiteral("projects"),
                 services.projects ? services.projects->list() : QJsonArray{});

    QJsonArray sessions;
    if (services.catalog) {
        for (const QJsonValue &value : services.catalog->listRecords()) {
            if (!isVisibleRecord(value.toObject())) continue;
            sessions.append(value);
        }
    }
    state.insert(QStringLiteral("sessions"), sessions);

    QSet<QString> visibleIds;
    for (const QJsonValue &value : sessions) {
        visibleIds.insert(value.toObject().value(QStringLiteral("id")).toString());
    }

    QJsonArray runtimes;
    QSet<QString> visibleRuntimeSessions;
    QJsonObject messagesBySession;
    QStringList activating;
    if (services.runtimeCoordinator) {
        for (const QJsonValue &value : services.runtimeCoordinator->listRuntimes().toArray()) {
            const QString sessionId =
                value.toObject().value(QStringLiteral("sessionId")).toString();
            if (!visibleIds.contains(sessionId)) continue;
            runtimes.append(value);
            visibleRuntimeSessions.insert(sessionId);
        }
        for (const QString &sessionId : visibleRuntimeSessions) {
            const QJsonObject snapshot = services.runtimeCoordinator->runtimeMessages(sessionId);
            if (snapshot.isEmpty()) continue;
            // Only a snapshot whose target still matches the listed runtime is delivered:
            // a replaced process would otherwise push stale messages into the browser.
            const QJsonObject target = snapshot.value(QStringLiteral("target")).toObject();
            if (target.value(QStringLiteral("sessionId")).toString() != sessionId) continue;
            bool matches = false;
            for (const QJsonValue &value : runtimes) {
                const QJsonObject runtime = value.toObject();
                if (runtime.value(QStringLiteral("sessionId")).toString() != sessionId) continue;
                matches = runtime.value(QStringLiteral("agentId")) == target.value(QStringLiteral("agentId"))
                    && runtime.value(QStringLiteral("runtimeGeneration"))
                        == target.value(QStringLiteral("runtimeGeneration"));
                break;
            }
            if (!matches) continue;
            messagesBySession.insert(sessionId, snapshot.value(QStringLiteral("value")));
        }
        for (const QString &sessionId : services.runtimeCoordinator->activatingSessions()) {
            if (visibleIds.contains(sessionId)) activating.append(sessionId);
        }
    }
    state.insert(QStringLiteral("runtimes"), runtimes);
    state.insert(QStringLiteral("activatingSessionIds"),
                 QJsonArray::fromStringList(activating));
    state.insert(QStringLiteral("messagesBySession"), messagesBySession);

    QJsonArray pending;
    if (services.runtimeCoordinator) {
        // Pending requests are stored per session; collect them for every visible runtime
        // so a browser that just loaded the page can answer an in-flight question.
        for (const QString &sessionId : visibleRuntimeSessions) {
            for (const QJsonValue &value : services.runtimeCoordinator->pendingUiRequests(sessionId)) {
                pending.append(value);
            }
        }
    }
    state.insert(QStringLiteral("pendingUiRequests"), pending);
    return state;
}

} // namespace webstate
