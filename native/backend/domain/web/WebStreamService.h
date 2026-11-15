#pragma once

#include "WebStreamRouter.h"

#include <QHash>
#include <QJsonObject>
#include <QObject>
#include <QPointer>
#include <QString>

#include <functional>

class QTcpSocket;
class WebStreamConnection;

namespace runtime {
class Coordinator;
}

namespace webstream {

/**
 * LAN AI SDK stream owner: configures the router from the runtime coordinator and owns
 * the open SSE connections.
 *
 * Two lifetimes are involved and must be paired:
 *  - the pi-event/state observers belong to the *service* (added on `start`, removed on
 *    `stop`, so a stopped service never forwards to a dead socket);
 *  - the per-response connection belongs to one HTTP request and is destroyed when the
 *    browser disconnects or the run finishes.
 * Run state (translator + subscribers) lives in the router and survives a reconnect.
 */
class Service : public QObject {
public:
    using LogSink = std::function<void(const QString &level, const QString &message,
                                       const QJsonObject &detail)>;

    struct Deps {
        runtime::Coordinator *coordinator = nullptr;
        LogSink log;
    };

    explicit Service(Deps deps, QObject *parent = nullptr);
    ~Service() override;

    /** Subscribe to pi events and runtime snapshots. Idempotent. */
    void start();
    /** Unsubscribe and close every open stream. Idempotent. */
    void stop();
    bool started() const { return m_started; }
    /** False when the backend has no runtime owner (the stream is then genuinely absent). */
    bool available() const { return m_deps.coordinator != nullptr; }

    /**
     * Take ownership of `socket` and answer it as one SSE stream.
     *
     * `admission` distinguishes the POST (`dispatch`: subscribe before the prompt, stay
     * open while the runtime activates) from the GET (`observe`: finish immediately when
     * there is nothing to watch). `replayTools` is the GET-only cold-start recovery.
     */
    bool open(const QString &sessionId, QTcpSocket *socket, Admission admission, bool replayTools);

    /**
     * The dispatch prompt settled: clear the pending flag and either report the rejection
     * as an `error` frame or re-apply the runtime admission.
     */
    void promptDispatched(const QString &sessionId, const QString &errorText);

private:
    struct Entry {
        QPointer<WebStreamConnection> connection;
        QString sessionId;
        int subscriberToken = 0;
    };

    void observe();
    void dropConnection(int id);

    Deps m_deps;
    Router m_router;
    QHash<int, Entry> m_connections;
    int m_nextConnectionId = 1;
    int m_piObserver = 0;
    int m_stateObserver = 0;
    bool m_started = false;
};

} // namespace webstream
