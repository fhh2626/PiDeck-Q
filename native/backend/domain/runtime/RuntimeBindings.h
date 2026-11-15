#pragma once

#include "RuntimeTypes.h"

#include <QHash>
#include <QSet>
#include <QString>

/**
 * Binding state machine for session runtimes.
 *
 * Owns the only authoritative mapping between a stable session id and the transient
 * pi process handle, plus the monotonic generation that makes late replies detectable.
 * Port of the binding half of src/main/sessions/SessionRuntimeCoordinator.ts.
 *
 * Rules encoded here (each one is a data-integrity guard, not a convenience):
 *  - one session -> one agent, one agent -> one session; rebinding bumps the generation;
 *  - an activation holds a per-session lock so two concurrent sends cannot spawn two
 *    processes for the same session;
 *  - a replacement (restart/fork/clone) reserves both the session and the agent, so no
 *    dispatch can slip through while the process identity is changing;
 *  - a dispatch lease pins `sessionId + agentId + runtimeGeneration` for the duration of
 *    a command; a lease that is no longer current means the reply must be discarded.
 */
namespace runtime {

class Bindings {
public:
    /** Bind (or rebind) a session to an agent. Returns the new generation. */
    int bind(const QString &sessionId, const QString &agentId);
    void unbind(const QString &agentId);
    void unbindSession(const QString &sessionId);

    bool bindingForAgent(const QString &agentId, QString *sessionId, int *generation) const;
    bool targetForSession(const QString &sessionId, Target *out) const;
    QString agentForSession(const QString &sessionId) const { return m_agentIdBySession.value(sessionId); }
    QString sessionForAgent(const QString &agentId) const { return m_sessionIdByAgent.value(agentId); }
    int generationForSession(const QString &sessionId) const { return m_generationBySession.value(sessionId); }
    QStringList boundSessions() const { return m_agentIdBySession.keys(); }

    /** Activation lock: false when another activation for the session is in flight. */
    bool beginActivation(const QString &sessionId);
    void endActivation(const QString &sessionId);
    bool isActivating(const QString &sessionId) const { return m_activating.contains(sessionId); }
    /** Sessions with an activation in flight (Web `/api/state`). */
    QStringList activatingSessions() const { return m_activating.values(); }

    struct Reservation {
        bool valid = false;
        Target previous;
        int reservedGeneration = 0;
    };
    /** Reserve a bound runtime for replacement; the generation moves on the next bind. */
    Reservation beginReplacement(const QString &sessionId, const QString &agentId);
    void finishReplacement(const QString &sessionId, const QString &agentId);
    bool isReplacing(const QString &sessionId, const QString &agentId) const;
    /**
     * True while a replacement reservation owns the session.
     *
     * The reservation survives the whole handshake (restart keeps it until the new process
     * answered `get_state` and preferences), so an activation must be refused instead of
     * spawning a second process for the same session (oracle `activate`: "Session runtime
     * replacement reservation conflict").
     */
    bool isReplacingSession(const QString &sessionId) const
    {
        return m_replacementTokens.contains(sessionId);
    }
    /**
     * Commit a replacement reservation: verify the caller still owns it, drop it, and bind
     * the new runtime in one step.
     *
     * Ownership check + release + bind must not yield, otherwise a competing activation or
     * replacement could win the session in between and the returned generation would be a
     * stale success. Throws when the reservation is gone or the target is already owned.
     */
    int completeReplacement(const QString &sessionId, const QString &agentId,
                            const QString &newSessionId, const QString &newAgentId);

    /** Acquire a dispatch lease; throws a std::runtime_error when dispatch is blocked. */
    quint64 acquireLease(const Target &target);
    void releaseLease(quint64 leaseId);
    bool leaseCurrent(quint64 leaseId) const;
    bool hasLease(const QString &sessionId, const QString &agentId) const;
    void assertNoLease(const QString &sessionId, const QString &agentId) const;

private:
    struct Lease {
        Target target;
        bool active = false;
    };

    void addLease(QHash<QString, QSet<quint64>> &map, const QString &key, quint64 leaseId);
    void removeLease(QHash<QString, QSet<quint64>> &map, const QString &key, quint64 leaseId);

    QHash<QString, QString> m_agentIdBySession;
    QHash<QString, QString> m_sessionIdByAgent;
    QHash<QString, int> m_generationBySession;
    QSet<QString> m_activating;
    QSet<QString> m_replacingSessions;
    QSet<QString> m_replacingAgents;
    // Session-level reservation tickets. Kept apart from the agent set because a dead
    // process' unbind may drop the agent half while the session must stay reserved.
    QHash<QString, quint64> m_replacementTokens;
    quint64 m_replacementSequence = 0;
    QHash<quint64, Lease> m_leases;
    QHash<QString, QSet<quint64>> m_leasesBySession;
    QHash<QString, QSet<quint64>> m_leasesByAgent;
    quint64 m_leaseSequence = 0;
};

} // namespace runtime
