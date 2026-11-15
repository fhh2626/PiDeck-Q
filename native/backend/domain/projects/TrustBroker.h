#pragma once

#include <QHash>
#include <QJsonObject>
#include <QString>

#include <functional>

class QTimer;

class EventHub;

/**
 * Project trust decisions (`~/.pi/agent/trust.json`) plus the interactive prompt.
 *
 * Port of ConfigManager's trust helpers and AgentManager's `requestProjectTrust`.
 * pi itself only records a boolean per directory and inherits it down the tree, so the
 * store has to reproduce the nearest-parent lookup exactly; the prompt exists because an
 * undetermined decision must never silently grant project-level extensions/skills.
 */
namespace projects {

/** `trust-remember` / `trust-session` / `deny`, matching the renderer's choices. */
using TrustChoice = QString;

class TrustBroker {
public:
    using Request = std::function<void(const QString &requestId, const QString &cwd,
                                       const QString &projectName)>;

    TrustBroker(QString agentDir, EventHub *events);
    ~TrustBroker();

    /** Raw `trust.json` contents (the `config:get-trust` payload). */
    QJsonObject readConfig() const;

    /**
     * Nearest recorded decision for `cwd` (`true`/`false`), or a null value when the
     * directory chain has no entry. `readError` is set when trust.json exists but cannot
     * be read, so callers can fail closed instead of treating it as "no decision".
     */
    QJsonValue decision(const QString &cwd, bool *readError = nullptr) const;

    /** Record one directory decision (overwrites an existing key). */
    void setDecision(const QString &cwd, bool trusted);

    /** Record trust for `directoryPath` unless any spelling of it is already present. */
    void ensureTrusted(const QString &directoryPath);

    /**
     * Ask the renderer for a decision and wait for `projects:trust-response`.
     *
     * Resolves `deny` after the oracle's 60 s timeout, and immediately when no window is
     * listening, so agent creation can never hang forever.
     */
    void request(const QString &cwd, const QString &projectName,
                 std::function<void(const TrustChoice &)> done);

    /** Answer a pending request. Unknown ids are ignored, exactly like the oracle. */
    void respond(const QString &requestId, const TrustChoice &choice);

    /** Fail every pending request (shutdown) so no continuation outlives the backend. */
    void cancelAll();

private:
    struct Pending {
        std::function<void(const TrustChoice &)> done;
        /** Owned by this broker: deleted on settle and in ~TrustBroker. */
        QTimer *timeout = nullptr;
    };

    QString m_agentDir;
    EventHub *m_events = nullptr;
    QHash<QString, Pending> m_pending;
};

} // namespace projects
