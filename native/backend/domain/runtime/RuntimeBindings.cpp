#include "RuntimeBindings.h"

#include "../ChannelRegistry.h"

#include <QStringList>

#include <stdexcept>

namespace runtime {
namespace {

/**
 * Binding violations are ChannelError: it carries the original QString message and is
 * the exception type the channel layer already understands.
 */
ChannelError failure(const QString &message)
{
    return ChannelError(message);
}

} // namespace

int Bindings::bind(const QString &sessionId, const QString &agentId)
{
    assertNoLease(sessionId, agentId);
    if (m_replacingAgents.contains(agentId)) {
        throw failure(QStringLiteral("Session runtime replacement already in progress: %1").arg(agentId));
    }
    if (m_replacingSessions.contains(sessionId)) {
        throw failure(QStringLiteral("Session runtime replacement reservation conflict: %1").arg(sessionId));
    }
    const QString previousAgent = m_agentIdBySession.value(sessionId);
    if (previousAgent == agentId && m_sessionIdByAgent.value(agentId) == sessionId) {
        return m_generationBySession.value(sessionId);
    }
    if (!previousAgent.isEmpty() && previousAgent != agentId) {
        m_sessionIdByAgent.remove(previousAgent);
    }
    const QString previousSession = m_sessionIdByAgent.value(agentId);
    if (!previousSession.isEmpty() && previousSession != sessionId) {
        m_agentIdBySession.remove(previousSession);
    }
    const int generation = m_generationBySession.value(sessionId) + 1;
    m_generationBySession.insert(sessionId, generation);
    m_agentIdBySession.insert(sessionId, agentId);
    m_sessionIdByAgent.insert(agentId, sessionId);
    return generation;
}

void Bindings::unbind(const QString &agentId)
{
    const QString sessionId = m_sessionIdByAgent.take(agentId);
    if (!sessionId.isEmpty()) m_agentIdBySession.remove(sessionId);
    m_replacingAgents.remove(agentId);
}

void Bindings::unbindSession(const QString &sessionId)
{
    const QString agentId = m_agentIdBySession.take(sessionId);
    if (!agentId.isEmpty()) m_sessionIdByAgent.remove(agentId);
    m_replacingSessions.remove(sessionId);
}

bool Bindings::bindingForAgent(const QString &agentId, QString *sessionId, int *generation) const
{
    const QString bound = m_sessionIdByAgent.value(agentId);
    if (bound.isEmpty()) return false;
    // A half-written binding (session points elsewhere) is not a binding.
    if (m_agentIdBySession.value(bound) != agentId) return false;
    if (sessionId) *sessionId = bound;
    if (generation) *generation = m_generationBySession.value(bound);
    return true;
}

bool Bindings::targetForSession(const QString &sessionId, Target *out) const
{
    const QString agentId = m_agentIdBySession.value(sessionId);
    if (agentId.isEmpty()) return false;
    if (m_sessionIdByAgent.value(agentId) != sessionId) return false;
    if (out) {
        out->sessionId = sessionId;
        out->agentId = agentId;
        out->runtimeGeneration = m_generationBySession.value(sessionId);
    }
    return true;
}

bool Bindings::beginActivation(const QString &sessionId)
{
    if (m_activating.contains(sessionId)) return false;
    m_activating.insert(sessionId);
    return true;
}

void Bindings::endActivation(const QString &sessionId)
{
    m_activating.remove(sessionId);
}

Bindings::Reservation Bindings::beginReplacement(const QString &sessionId, const QString &agentId)
{
    Reservation reservation;
    Target current;
    if (!targetForSession(sessionId, &current) || current.agentId != agentId) return reservation;
    assertNoLease(sessionId, agentId);
    if (m_replacingAgents.contains(agentId) || m_replacingSessions.contains(sessionId)) {
        throw failure(QStringLiteral("Session runtime replacement already in progress: %1").arg(agentId));
    }
    // The binding is removed before the process is replaced, so any in-flight reply
    // from the old process already fails the target check. The generation itself only
    // moves on the next bind, which keeps one restart equal to one generation step.
    reservation.valid = true;
    reservation.previous = current;
    reservation.reservedGeneration = m_generationBySession.value(sessionId) + 1;
    m_agentIdBySession.remove(sessionId);
    m_sessionIdByAgent.remove(agentId);
    m_replacingSessions.insert(sessionId);
    m_replacingAgents.insert(agentId);
    m_replacementTokens.insert(sessionId, ++m_replacementSequence);
    return reservation;
}

void Bindings::finishReplacement(const QString &sessionId, const QString &agentId)
{
    m_replacingSessions.remove(sessionId);
    m_replacingAgents.remove(agentId);
    m_replacementTokens.remove(sessionId);
}

int Bindings::completeReplacement(const QString &sessionId, const QString &agentId,
                                 const QString &newSessionId, const QString &newAgentId)
{
    // One synchronous step: no dispatch, activation or second replacement can observe a
    // half-released reservation or steal the target between the check and the bind.
    if (!m_replacementTokens.contains(sessionId)) {
        throw failure(QStringLiteral("Session runtime replacement reservation lost: %1").arg(sessionId));
    }
    assertNoLease(newSessionId, newAgentId);
    const QString owner = m_agentIdBySession.value(newSessionId);
    if (!owner.isEmpty() && owner != newAgentId) {
        throw failure(QStringLiteral("Session runtime target already bound: %1").arg(newSessionId));
    }
    m_replacementTokens.remove(sessionId);
    m_replacingSessions.remove(sessionId);
    m_replacingAgents.remove(agentId);
    return bind(newSessionId, newAgentId);
}

bool Bindings::isReplacing(const QString &sessionId, const QString &agentId) const
{
    return m_replacingSessions.contains(sessionId) || m_replacingAgents.contains(agentId);
}

quint64 Bindings::acquireLease(const Target &target)
{
    if (isReplacing(target.sessionId, target.agentId)) {
        throw failure(QStringLiteral("Session runtime replacement is in progress"));
    }
    QString sessionId;
    int generation = 0;
    if (!bindingForAgent(target.agentId, &sessionId, &generation) || sessionId != target.sessionId) {
        throw failure(QStringLiteral("Session runtime binding changed before prompt dispatch"));
    }
    Lease lease;
    lease.target = target;
    lease.target.runtimeGeneration = generation;
    lease.active = true;
    const quint64 leaseId = ++m_leaseSequence;
    m_leases.insert(leaseId, lease);
    addLease(m_leasesBySession, target.sessionId, leaseId);
    addLease(m_leasesByAgent, target.agentId, leaseId);
    return leaseId;
}

void Bindings::releaseLease(quint64 leaseId)
{
    const auto found = m_leases.find(leaseId);
    if (found == m_leases.end()) return;
    removeLease(m_leasesBySession, found->target.sessionId, leaseId);
    removeLease(m_leasesByAgent, found->target.agentId, leaseId);
    m_leases.erase(found);
}

bool Bindings::leaseCurrent(quint64 leaseId) const
{
    const auto found = m_leases.constFind(leaseId);
    if (found == m_leases.constEnd() || !found->active) return false;
    const Target &target = found->target;
    if (!m_leasesBySession.value(target.sessionId).contains(leaseId)) return false;
    if (!m_leasesByAgent.value(target.agentId).contains(leaseId)) return false;
    QString sessionId;
    int generation = 0;
    if (!bindingForAgent(target.agentId, &sessionId, &generation)) return false;
    return sessionId == target.sessionId && generation == target.runtimeGeneration
        && m_agentIdBySession.value(target.sessionId) == target.agentId;
}

bool Bindings::hasLease(const QString &sessionId, const QString &agentId) const
{
    return !m_leasesBySession.value(sessionId).isEmpty() || !m_leasesByAgent.value(agentId).isEmpty();
}

void Bindings::assertNoLease(const QString &sessionId, const QString &agentId) const
{
    if (hasLease(sessionId, agentId)) {
        throw failure(QStringLiteral("Session runtime prompt dispatch is in progress"));
    }
}

void Bindings::addLease(QHash<QString, QSet<quint64>> &map, const QString &key, quint64 leaseId)
{
    if (key.isEmpty()) return;
    map[key].insert(leaseId);
}

void Bindings::removeLease(QHash<QString, QSet<quint64>> &map, const QString &key, quint64 leaseId)
{
    auto found = map.find(key);
    if (found == map.end()) return;
    found->remove(leaseId);
    if (found->isEmpty()) map.erase(found);
}

} // namespace runtime
