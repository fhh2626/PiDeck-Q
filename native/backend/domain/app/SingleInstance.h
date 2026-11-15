#pragma once

#include "app/FocusTargets.h"
#include "app/SingleInstanceClaim.h"
#include "app/SingleInstancePaths.h"

#include <QByteArray>
#include <QHash>
#include <QObject>
#include <QString>

#include <functional>
#include <memory>

class QLocalServer;
class QLocalSocket;

/**
 * Version-isolated single instance: exclusive ownership + per-version endpoint.
 *
 * Port of `src/main/singleInstance.ts`. The lock file is metadata only; primary-ness is
 * decided by `singleinstance::Claim` (a named mutex on Windows, `flock` on POSIX) whose
 * lifetime is the process lifetime, so a crashed primary cannot make every later launch
 * exit as secondary.
 *
 * Focus delivery then uses a per-version local endpoint (named pipe on Windows, Unix
 * domain socket on POSIX) whose name is derived from `<userData>\0<version>`. Only the
 * primary ever listens on it, so a secondary launch forwards its argv, waits for the
 * primary's receipt ACK and exits 0 — exactly like the oracle.
 */
namespace singleinstance {

/** `singleInstance` from `<userData>/settings.json`; only an explicit `false` disables. */
bool readEnabled(const QString &userDataDir);

class Guard : public QObject {
public:
    ~Guard() override;

    /**
     * Become the primary instance.
     *
     * Returns nullptr with an empty `error` when another live instance owns the claim
     * (the caller forwards and exits), or nullptr with `error` set when this process must
     * not start at all.
     */
    static std::unique_ptr<Guard> claim(const QString &version, const QString &userDataDir,
                                        QString *error);

    /** Install the payload handler; the listener may already be bound. */
    void setOnFocusRequest(std::function<void(const appfocus::Payload &)> handler);

    const QString &endpoint() const { return m_endpoint; }
    const QString &lockPath() const { return m_lockPath; }

    /** Release the endpoint, the OS claim and this instance's lock. Idempotent. */
    void dispose();

private:
    /** One inbound connection from a secondary instance; payloads are single-shot. */
    struct Connection {
        QByteArray buffer;
        bool handled = false;
        bool rejected = false;
    };

    Guard(QString endpoint, QString lockPath, QString instanceToken);

    static void readAvailable(Guard *self, QLocalSocket *socket);
    static void finishConnection(Guard *self, QLocalSocket *socket);
    static void settle(Guard *self, QLocalSocket *socket, Connection &connection, const QByteArray &raw);

    QLocalServer *m_server = nullptr;
    std::unique_ptr<Claim> m_claim;
    QHash<QLocalSocket *, Connection> m_connections;
    QString m_endpoint;
    QString m_lockPath;
    QString m_instanceToken;
    bool m_disposed = false;
    std::function<void(const appfocus::Payload &)> m_onFocusRequest;
};

/**
 * Forward one focus request to the primary and wait for its receipt ACK.
 *
 * A local write completing says nothing about delivery, so success means the primary
 * acknowledged the exact payload. Retries are bounded (3 attempts, 50/100 ms backoff),
 * matching the oracle.
 */
bool forwardFocusRequest(const QString &endpoint, const appfocus::Payload &payload,
                         int attempts = 3);

} // namespace singleinstance
