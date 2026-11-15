#include "app/Notifications.h"

#include "HostRpcClient.h"

#include <utility>

namespace appnotifications {
namespace {

QString eventId(const QJsonValue &payload)
{
    if (!payload.isObject()) return QString();
    return payload.toObject().value(QStringLiteral("id")).toString();
}

} // namespace

Service::Service(Deps deps, QObject *parent)
    : QObject(parent), m_deps(std::move(deps))
{
    if (!m_deps.host) return;
    m_deps.host->onEvent(QStringLiteral("notification.clicked"),
                         [this](const QJsonValue &payload) { release(payload, true, false); });
    m_deps.host->onEvent(QStringLiteral("notification.dismissed"),
                         [this](const QJsonValue &payload) { release(payload, false, false); });
    m_deps.host->onEvent(QStringLiteral("notification.failed"),
                         [this](const QJsonValue &payload) { release(payload, false, true); });
    m_deps.host->onEvent(QStringLiteral("notification.fallback"),
                         [this](const QJsonValue &payload) { release(payload, false, false); });
}

bool Service::supported() const
{
#if defined(Q_OS_WIN)
    // A diagnostics switch, not a product setting: it exists so a headless test run can
    // force the tray-only path on the same build.
    return qEnvironmentVariable("PIDECK_NATIVE_NOTIFICATIONS") != QLatin1String("0");
#else
    // Only the Windows Qt host implements the toast notifier.
    return false;
#endif
}

void Service::release(const QJsonValue &payload, bool click, bool failed)
{
    const QString id = eventId(payload);
    if (id.isEmpty()) return;
    auto iterator = m_callbacks.find(id);
    if (iterator == m_callbacks.end()) return;
    // Take before invoking: a callback that shows another notification must not have its
    // own map entry invalidated by this erase.
    const Callbacks callbacks = *iterator;
    m_callbacks.erase(iterator);
    if (click && callbacks.onClick) {
        callbacks.onClick();
        return;
    }
    if (failed && callbacks.onFailed) {
        const QString error = payload.toObject().value(QStringLiteral("error")).toString();
        callbacks.onFailed(error.isEmpty() ? QStringLiteral("Native notification failed") : error);
    }
    // Dismiss/fallback only release the closure: a tray balloon is deliberately
    // non-interactive, and no event can identify one balloon among several.
}

void Service::show(const QJsonObject &options, Callbacks callbacks)
{
    if (!m_deps.host) {
        if (callbacks.onFailed) callbacks.onFailed(QStringLiteral("Native host bridge is unavailable"));
        return;
    }
    const QString id = QStringLiteral("notification-%1").arg(++m_sequence);
    m_callbacks.insert(id, std::move(callbacks));
    QJsonObject params{
        {QStringLiteral("id"), id},
        {QStringLiteral("title"), options.value(QStringLiteral("title")).toString()},
        {QStringLiteral("body"), options.value(QStringLiteral("body")).toString()},
        {QStringLiteral("silent"), options.value(QStringLiteral("silent")).toBool(false)},
    };
    const QString activationUrl = options.value(QStringLiteral("activationUrl")).toString();
    if (!activationUrl.isEmpty()) params.insert(QStringLiteral("activationUrl"), activationUrl);

    auto request = m_deps.host->request(QStringLiteral("notification.show"), params);
    request->then([this, id](const QJsonValue &value) mutable {
        auto iterator = m_callbacks.find(id);
        if (iterator == m_callbacks.end()) return;
        // An older host answered null. Treat that as non-interactive so an upgraded
        // backend cannot retain a closure forever on the tray fallback path.
        if (!value.isObject()) {
            m_callbacks.erase(iterator);
            return;
        }
        const QJsonObject result = value.toObject();
        const QString backend = result.value(QStringLiteral("backend")).toString();
        const bool interactive = result.value(QStringLiteral("interactive")).toBool(false);
        if (backend != QLatin1String("toast") && backend != QLatin1String("tray")
            && backend != QLatin1String("none")) {
            m_callbacks.erase(iterator);
            return;
        }
        if (backend == QLatin1String("tray") && !interactive) {
            m_callbacks.erase(iterator);
            return;
        }
        if (backend != QLatin1String("none")) return;
        const Callbacks handlers = *iterator;
        m_callbacks.erase(iterator);
        if (handlers.onFailed) handlers.onFailed(QStringLiteral("Native notification backend is unavailable"));
    });
    request->fail([this, id](const QString &error) mutable {
        auto iterator = m_callbacks.find(id);
        if (iterator == m_callbacks.end()) return;
        const Callbacks handlers = *iterator;
        m_callbacks.erase(iterator);
        if (handlers.onFailed) handlers.onFailed(error);
    });
}

void Service::showSessionDone(const QString &agentId, const QString &sessionTitle, const QString &sessionId)
{
    const QJsonObject settings = m_deps.settings ? m_deps.settings() : QJsonObject{};
    // Same double gate as the oracle: the user setting first, then the platform.
    if (!settings.value(QStringLiteral("enableNotifications")).toBool(true)) return;
    if (!supported()) return;
    const QString body = m_deps.translate
        ? m_deps.translate(QStringLiteral("mainNotification.sessionDone"),
                           QJsonObject{{QStringLiteral("title"), sessionTitle}})
        : sessionTitle;
    // The toast activation URL carries the stable SessionRecord.id: the renderer indexes
    // sessions by that id, and a pi session id would silently fail to resolve.
    const QString activationUrl = sessionId.isEmpty() ? QStringLiteral("pideck://")
                                                      : QStringLiteral("pideck://session/") + sessionId;
    Callbacks callbacks;
    callbacks.onClick = [this, sessionId] {
        if (!m_deps.focus) return;
        const bool focused = m_deps.focus->focusSession(sessionId);
        if (!focused && m_deps.warn) {
            m_deps.warn(QStringLiteral("agent"), QStringLiteral("Notification focus skipped: no main window"),
                        QJsonObject{{QStringLiteral("sessionId"), sessionId}});
        }
    };
    callbacks.onFailed = [this, agentId](const QString &error) {
        if (!m_deps.warn) return;
        m_deps.warn(QStringLiteral("agent"), QStringLiteral("Session notification failed to show"),
                    QJsonObject{{QStringLiteral("agentId"), agentId}, {QStringLiteral("error"), error}});
    };
    show(QJsonObject{
             {QStringLiteral("title"), m_deps.appName},
             {QStringLiteral("body"), body},
             {QStringLiteral("silent"), false},
             {QStringLiteral("activationUrl"), activationUrl},
         },
         std::move(callbacks));
}

bool Service::showAskPending(const QString &agentId, const QString &sessionTitle,
                             const QString &question, const QString &sessionId)
{
    const QJsonObject settings = m_deps.settings ? m_deps.settings() : QJsonObject{};
    if (!settings.value(QStringLiteral("enableNotifications")).toBool(true)) return false;
    if (!supported()) return false;
    // Per-run dedupe happens after the gates: disabling notifications and then asking
    // again in the same turn must still notify once notifications are re-enabled.
    if (m_askNotified.contains(agentId)) return false;
    m_askNotified.insert(agentId);

    const QString title = sessionTitle.isEmpty() ? m_deps.appName : sessionTitle;
    // The bubble has room for roughly one short sentence; the full question stays in the
    // session view, this is only the "come look" hint.
    const QString questionText = question.size() > 60 ? question.left(60) + QStringLiteral("…") : question;
    const QString body = !questionText.isEmpty() && m_deps.translate
        ? m_deps.translate(QStringLiteral("mainNotification.askQuestion"),
                           QJsonObject{{QStringLiteral("title"), title},
                                       {QStringLiteral("question"), questionText}})
        : m_deps.translate
        ? m_deps.translate(QStringLiteral("mainNotification.askPending"),
                           QJsonObject{{QStringLiteral("title"), title}})
        : title;
    const QString activationUrl = sessionId.isEmpty() ? QStringLiteral("pideck://")
                                                      : QStringLiteral("pideck://session/") + sessionId;
    Callbacks callbacks;
    callbacks.onClick = [this, sessionId] {
        if (!m_deps.focus) return;
        const bool focused = m_deps.focus->focusSession(sessionId);
        if (!focused && m_deps.warn) {
            m_deps.warn(QStringLiteral("agent"),
                        QStringLiteral("Notification focus skipped: no main window"),
                        QJsonObject{{QStringLiteral("sessionId"), sessionId}});
        }
    };
    callbacks.onFailed = [this, agentId](const QString &error) {
        if (!m_deps.warn) return;
        m_deps.warn(QStringLiteral("agent"), QStringLiteral("Ask notification failed to show"),
                    QJsonObject{{QStringLiteral("agentId"), agentId},
                                {QStringLiteral("error"), error}});
    };
    show(QJsonObject{
             {QStringLiteral("title"), m_deps.appName},
             {QStringLiteral("body"), body},
             {QStringLiteral("silent"), false},
             {QStringLiteral("activationUrl"), activationUrl},
         },
         std::move(callbacks));
    return true;
}

void Service::noteRunStarted(const QString &agentId)
{
    if (!agentId.isEmpty()) m_askNotified.remove(agentId);
}

void Service::forgetAgent(const QString &agentId)
{
    if (!agentId.isEmpty()) m_askNotified.remove(agentId);
}

} // namespace appnotifications
