#include "RuntimeCoordinator.h"

#include "../sessions/SessionEntryIds.h"

namespace runtime {
namespace {
constexpr int kMessagesTimeoutMs = 120'000;
constexpr int kEntriesTimeoutMs = 15'000;
} // namespace

void Coordinator::loadProjection(AgentSession &session, std::function<void(bool)> done)
{
    const QString agentId = session.tab().id;
    if (m_shutdown) {
        if (done) done(false);
        return;
    }
    const quint64 epoch = session.clientEpoch();
    QString sessionId;
    int generation = 0;
    const bool wasBound = m_bindings.bindingForAgent(agentId, &sessionId, &generation);
    const Target owner{sessionId, agentId, generation};
    auto &load = m_projectionLoads[agentId];
    if (load.ticket == 0) load.ticket = ++m_nextProjectionTicket;
    // Retries preserve local overlays within the same binding only. A newer clone or
    // reconnect can join this ticket, but must not inherit the previous session's errors
    // or settlement budget. Take its baseline when it requests the refresh, not on retry.
    if (load.preservationEpoch != epoch || !(load.preservationOwner == owner)) {
        load.preservationOwner = owner;
        load.preservationEpoch = epoch;
        load.diagnosticRevision = session.transcript().diagnosticRevision();
        load.trimRevision = session.transcript().trimRevision();
    }
    // A compaction/replacement requested after get_messages began needs a newer
    // snapshot even when it did not change a visible transcript row yet.
    if (load.inFlight) load.refreshAgain = true;
    if (done) {
        // Coalesced callers can belong to different replacement generations. A fresh
        // snapshot satisfies only the identity which requested it, not superseded callers.
        load.waiters.append([this, agentId, epoch, sessionId, generation, wasBound,
                             done = std::move(done)](bool projected) {
            const AgentSession *current = agent(agentId);
            QString currentSession;
            int currentGeneration = 0;
            const bool isBound = m_bindings.bindingForAgent(agentId, &currentSession, &currentGeneration);
            done(projected && current && current->running() && current->clientEpoch() == epoch
                 && isBound == wasBound && (!wasBound || (currentSession == sessionId
                     && currentGeneration == generation)));
        });
    }
    tryLoadProjection(agentId);
}

void Coordinator::finishProjectionLoad(const QString &agentId, quint64 ticket, bool projected)
{
    auto found = m_projectionLoads.find(agentId);
    if (found == m_projectionLoads.end() || found->ticket != ticket) return;
    // Erase before calling out: a completion can request another reload or dispose its
    // runtime. It must never inherit this load's in-flight bit or callback vector.
    auto waiters = std::move(found->waiters);
    m_projectionLoads.erase(found);
    for (const auto &done : waiters) if (done) done(projected);
}

void Coordinator::tryLoadProjection(const QString &agentId)
{
    auto found = m_projectionLoads.find(agentId);
    if (found == m_projectionLoads.end() || found->inFlight) return;
    const quint64 ticket = found->ticket;
    AgentSession *session = agent(agentId);
    if (m_shutdown || !session || !session->running()) {
        finishProjectionLoad(agentId, ticket);
        return;
    }
    // Empty skeletons have no reliable pi identity. Keep their live UUID until the
    // message ends, then request a fresh authoritative snapshot. Content/last-row
    // guesses would confuse two replies containing the same image or thinking text.
    if (!session->transcript().activeAssistantId().isEmpty()) {
        if (session->turnActive() || session->tab().isStreaming) return;
        // A settled/aborted runtime may omit message_end. No reply is still live.
        session->transcript().clearActiveAssistant();
    }
    found->inFlight = true;
    found->refreshAgain = false;
    const int sequence = session->beginMessageLoad();
    const quint64 epoch = session->clientEpoch();
    const int runGeneration = session->runGeneration();
    QString boundSession;
    int boundGeneration = 0;
    const bool wasBound = m_bindings.bindingForAgent(agentId, &boundSession, &boundGeneration);
    const QJsonArray beforeLoad = session->transcript().messages();
    session->request(QStringLiteral("get_messages"), {}, kMessagesTimeoutMs,
        [this, agentId, ticket, sequence, epoch, runGeneration, beforeLoad, wasBound, boundSession, boundGeneration](
            bool ok, const QJsonObject &response, const QString &) {
            auto load = m_projectionLoads.find(agentId);
            if (load == m_projectionLoads.end() || load->ticket != ticket) return;
            AgentSession *current = agent(agentId);
            if (!current || !current->running() || current->clientEpoch() != epoch
                || current->messageLoadSequence() != sequence) {
                finishProjectionLoad(agentId, ticket);
                return;
            }
            if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                // A newer refresh request is independent of the failed read. Consume
                // that request once, without endlessly retrying an unavailable provider.
                if (load->refreshAgain && current->running()) {
                    load->inFlight = false;
                    tryLoadProjection(agentId);
                } else {
                    finishProjectionLoad(agentId, ticket);
                }
                return;
            }
            QVector<QJsonValue> raw;
            for (const auto &value : response.value(QStringLiteral("data")).toObject()
                     .value(QStringLiteral("messages")).toArray()) raw.append(value);
            current->request(QStringLiteral("get_entries"), {}, kEntriesTimeoutMs,
                [this, agentId, ticket, sequence, epoch, runGeneration, beforeLoad, raw, wasBound, boundSession, boundGeneration](
                    bool entriesOk, const QJsonObject &entriesResponse, const QString &) {
                    auto load = m_projectionLoads.find(agentId);
                    if (load == m_projectionLoads.end() || load->ticket != ticket) return;
                    AgentSession *latest = agent(agentId);
                    QString currentSession;
                    int currentGeneration = 0;
                    const bool isBound = m_bindings.bindingForAgent(agentId, &currentSession, &currentGeneration);
                    // Pending RPCs fail before the exit handler detaches the binding. A
                    // failed optional entries read is safe only while this exact runtime lives.
                    if (!latest || !latest->running() || latest->clientEpoch() != epoch
                        || latest->messageLoadSequence() != sequence) {
                        finishProjectionLoad(agentId, ticket);
                        return;
                    }
                    // get_entries is a second round trip. If a new reply/tool row arrived
                    // meanwhile, neither this snapshot nor its entry-id alignment is safe.
                    // Retry at the next message boundary instead of dropping the refresh
                    // and falsely completing the operation on the previous projection.
                    // A replacement may have committed while this read was pending.
                    // Retain newer waiters and reread for the current binding; completion
                    // validates each caller's identity separately, so the old one fails.
                    if (isBound != wasBound || (wasBound && (currentSession != boundSession
                            || currentGeneration != boundGeneration))
                        || load->refreshAgain || latest->runGeneration() != runGeneration
                        || !latest->transcript().activeAssistantId().isEmpty()
                        || latest->transcript().messages() != beforeLoad) {
                        load->inFlight = false;
                        tryLoadProjection(agentId);
                        return;
                    }
                    QStringList entryIds;
                    if (entriesOk && entriesResponse.value(QStringLiteral("success")).toBool(false)) {
                        const QJsonObject data = entriesResponse.value(QStringLiteral("data")).toObject();
                        QVector<QJsonValue> entries;
                        for (const auto &value : data.value(QStringLiteral("entries")).toArray()) entries.append(value);
                        entryIds = sessionentryids::buildActiveBranchEntryIds(
                            entries, data.value(QStringLiteral("leafId")).toString());
                        latest->setEntrySource(QStringLiteral("rpc"));
                    }
                    latest->setActiveEntryIds(entryIds);
                    auto &transcript = latest->transcript();
                    const QJsonArray previous = transcript.messages();
                    const bool settledDuringLoad = transcript.trimRevision() != load->trimRevision;
                    transcript.applyProjection(raw, entryIds, missingtoolcalls::collectToolResultIds(raw));
                    transcript.preserveDiagnosticsSince(load->diagnosticRevision, previous);
                    // A projection crossing settlement must retain its 50-turn budget.
                    if (settledDuringLoad) transcript.trimToTurns(50);
                    latest->refreshFileVersion();
                    agentruntime::flushMessages(*latest, hooksFor(*latest));
                    finishProjectionLoad(agentId, ticket, true);
                });
        });
}

} // namespace runtime
