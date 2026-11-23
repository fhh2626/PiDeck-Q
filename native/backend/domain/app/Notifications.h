#pragma once

#include "../MainCopy.h"
#include "app/FocusQueue.h"

#include <QHash>
#include <QJsonObject>
#include <QJsonValue>
#include <QObject>
#include <QSet>
#include <QString>

#include <functional>

class HostRpcClient;

/**
 * Desktop notifications produced by the backend.
 *
 * Port of `src/native-node/platform/NativeNotifications.ts` plus the toast semantics of
 * `AgentManager.notifySessionEnd` (src/main/pi/AgentManager.ts). The Qt host owns
 * `notification.show` and reports back through four events:
 *
 *  - `notification.clicked`   → run the click callback (focus window + session);
 *  - `notification.dismissed` → release the callback, no navigation;
 *  - `notification.fallback`  → tray balloon is non-interactive, release the callback;
 *  - `notification.failed`    → surface the error to the caller's `onFailed`.
 *
 * Callbacks are keyed by the notification id the backend minted, so a stale id from a
 * previous process cannot invoke a newer notification's closure.
 */
namespace appnotifications {

class Service : public QObject {
public:
    struct Deps {
        HostRpcClient *host = nullptr;
        appfocus::Queue *focus = nullptr;
        /** Fresh settings read: `enableNotifications` must follow a settings change. */
        std::function<QJsonObject()> settings;
        maincopy::Translator translate;
        /** Application name shown as the notification title (`PIDECK_NAME`). */
        QString appName;
        /** `(scope, message, detail)` warning sink; the app logger in production. */
        std::function<void(const QString &scope, const QString &message, const QJsonObject &detail)> warn;
    };

    explicit Service(Deps deps, QObject *parent = nullptr);

    /**
     * True when the running platform can raise a native toast (`win32`) and the
     * `PIDECK_NATIVE_NOTIFICATIONS=0` diagnostics switch is not set.
     */
    bool supported() const;

    /**
     * AgentManager.notifySessionEnd: "session completed its response".
     *
     * Gated by `enableNotifications` + `supported()`; a missing stable session id still
     * notifies but activates the app root (`pideck://`) instead of a session.
     */
    void showSessionDone(const QString &agentId, const QString &sessionTitle, const QString &sessionId);

    /**
     * AgentManager.notifyAskPending: a non-focused session is waiting for an answer.
     *
     * Same double gate as the completion toast, plus a per-run dedupe: the first ask of a
     * turn notifies, later asks of the same turn stay silent so a chatty tool cannot spam
     * the Action Center. `noteRunStarted` re-arms the agent for its next turn.
     *
     * Returns true when a notification was actually requested (diagnostics/tests).
     */
    bool showAskPending(const QString &agentId, const QString &sessionTitle, const QString &question,
                        const QString &sessionId);

    /** `agent_start`: the agent may notify about an ask again during the new run. */
    void noteRunStarted(const QString &agentId);
    /** The runtime is gone: drop its dedupe state so a reused id cannot inherit it. */
    void forgetAgent(const QString &agentId);

    /** Callbacks still waiting for a host event (diagnostics/tests). */
    int pending() const { return int(m_callbacks.size()); }

private:
    struct Callbacks {
        std::function<void()> onClick;
        std::function<void(const QString &error)> onFailed;
    };

    void show(const QJsonObject &options, Callbacks callbacks);
    void release(const QJsonValue &payload, bool click, bool failed);

    Deps m_deps;
    quint64 m_sequence = 0;
    QHash<QString, Callbacks> m_callbacks;
    /** Agents that already raised an ask toast in their current run. */
    QSet<QString> m_askNotified;
};

} // namespace appnotifications
