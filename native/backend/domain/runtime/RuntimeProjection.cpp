#include "RuntimeCoordinator.h"
#include "ProjectionFilePath.h"

#include "../sessions/SessionEntryIds.h"
#include "../sessions/JsonlIndex.h"
#include "BackgroundWork.h"

#include <algorithm>

namespace runtime {
namespace {
constexpr int kMessagesTimeoutMs = 120'000;
constexpr int kEntriesTimeoutMs = 15'000;
constexpr int kCheckpointPrefixSize = 2;

/** Verify a numeric seam for old RPC implementations that only return messages. */
int legacyCheckpointHead(const JsonlIndex &index, const QVector<QJsonValue> &raw)
{
    const auto roleOf = [](const QJsonValue &value) {
        return value.toObject().value(QStringLiteral("role")).toString();
    };
    if (raw.size() <= kCheckpointPrefixSize || roleOf(raw.at(0)) != QLatin1String("system")
        || roleOf(raw.at(1)) != QLatin1String("compactionSummary")) return -1;
    const auto checkpoint = std::find_if(index.activeBranch.crbegin(), index.activeBranch.crend(),
        [](const IndexEntry &entry) { return entry.type == QLatin1String("compaction"); });
    if (checkpoint == index.activeBranch.crend() || checkpoint->byteLength > 1024 * 1024
        || raw.at(1).toObject().value(QStringLiteral("summary")).toString() != checkpoint->summary) return -1;

    const int head = int(index.activeMessageEntries.size()) - int(raw.size()) + kCheckpointPrefixSize;
    if (head < 0) return -1;
    int firstKept = 0;
    bool found = false;
    for (const IndexEntry &entry : index.activeBranch) {
        if (entry.id == checkpoint->firstKeptEntryId) { found = true; break; }
        if (firstKept < index.activeMessageEntries.size()
            && index.activeMessageEntries.at(firstKept).id == entry.id) ++firstKept;
    }
    if (!found || firstKept != head) return -1;
    for (int i = kCheckpointPrefixSize; i < raw.size(); ++i) {
        const IndexEntry &entry = index.activeMessageEntries.at(head + i - kCheckpointPrefixSize);
        const QString role = roleOf(raw.at(i));
        // Past the two synthetic rows, an ordinary system message consumes a
        // slot just like any other stored message. Require its file role too.
        if (role != QLatin1String("system") && !sessionentryids::consumesMessageEntry(raw.at(i))) return -1;
        if (role != (entry.turnBoundary ? QStringLiteral("custom") : entry.role)) return -1;
    }
    // Only a disk-backed checkpoint may be skipped. A real system message at
    // the front would consume a file slot and make a count-based seam unsafe.
    const QJsonObject saved = jsonlindex::readEntry(index, *checkpoint).toObject();
    return saved.value(QStringLiteral("systemMessage")) == raw.at(0) ? head : -1;
}
} // namespace

void Coordinator::loadProjection(AgentSession &session, std::function<void(bool)> done,
                                  bool preserveHistory)
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
    load.preserveHistory = preserveHistory;
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
    const quint64 mutationRevision = m_historyMutationRevisions.value(boundSession).committed;
    const QJsonArray beforeLoad = session->transcript().messages();
    session->request(QStringLiteral("get_messages"), {}, kMessagesTimeoutMs,
        [this, agentId, ticket, sequence, epoch, runGeneration, beforeLoad, wasBound, boundSession, boundGeneration, mutationRevision](
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
                [this, agentId, ticket, sequence, epoch, runGeneration, beforeLoad, raw, wasBound, boundSession, boundGeneration, mutationRevision](
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
                    sessionentryids::ProjectionIds projection;
                    const bool hasEntries = entriesOk && entriesResponse.value(QStringLiteral("success")).toBool(false);
                    if (hasEntries) {
                        const QJsonObject data = entriesResponse.value(QStringLiteral("data")).toObject();
                        QVector<QJsonValue> entries;
                        for (const auto &value : data.value(QStringLiteral("entries")).toArray()) entries.append(value);
                        const QString leafId = data.value(QStringLiteral("leafId")).toString();
                        projection = sessionentryids::alignProjection(entries, leafId, raw);
                    }
                    const int roleCount = sessionentryids::countMessageEntries(raw);
                    const bool legacyCursor = projection.fileIds.isEmpty() && std::all_of(raw.begin(), raw.end(), [](const QJsonValue &value) {
                        const QString role = value.toObject().value(QStringLiteral("role")).toString();
                        return sessionentryids::consumesMessageEntry(value)
                            || role == QLatin1String("compactionSummary") || role == QLatin1String("branchSummary");
                    });
                    const auto apply = [this, agentId, ticket, sequence, epoch, runGeneration, beforeLoad,
                                        raw, ids = projection.messageIds, matched = projection.matched,
                                        hasEntries, legacyCursor, roleCount, wasBound, boundSession, boundGeneration, mutationRevision](
                                           const QStringList &fileIds, bool cursorKnown, int checkpointHead = -1) {
                        auto load = m_projectionLoads.find(agentId);
                        if (load == m_projectionLoads.end() || load->ticket != ticket) return;
                        AgentSession *latest = agent(agentId);
                        QString currentSession;
                        int currentGeneration = 0;
                        const bool isBound = m_bindings.bindingForAgent(agentId, &currentSession, &currentGeneration);
                        if (!latest || !latest->running() || latest->clientEpoch() != epoch
                            || latest->messageLoadSequence() != sequence) {
                            finishProjectionLoad(agentId, ticket);
                            return;
                        }
                        // The optional file cursor read runs on the serial worker. A reply,
                        // replacement or another refresh while it was queued invalidates
                        // the projection just as it does during get_entries.
                        if (isBound != wasBound || (wasBound && (currentSession != boundSession
                                || currentGeneration != boundGeneration))
                            || load->refreshAgain || latest->runGeneration() != runGeneration
                            || !latest->transcript().activeAssistantId().isEmpty()
                            || latest->transcript().messages() != beforeLoad) {
                            load->inFlight = false;
                            tryLoadProjection(agentId);
                            return;
                        }
                        latest->setActiveEntryIds(ids);
                        if (hasEntries) latest->setEntrySource(QStringLiteral("rpc"));
                        auto &transcript = latest->transcript();
                        const QJsonArray previous = transcript.messages();
                        const bool settledDuringLoad = transcript.trimRevision() != load->trimRevision;
                        transcript.applyProjection(raw, ids, missingtoolcalls::collectToolResultIds(raw),
                            matched ? projector::EntryIdLayout::Matched : projector::EntryIdLayout::Legacy,
                            checkpointHead >= 0 ? kCheckpointPrefixSize : -1);
                        // Exact IDs give the history cursor directly. The end of the file
                        // is only a fallback for rows appended after this projection.
                        const int fallback = !cursorKnown ? -1 : matched ? int(fileIds.size())
                            : legacyCursor ? std::max(0, int(fileIds.size()) - roleCount) : checkpointHead;
                        bool preserveHistory = load->preserveHistory;
                        const auto mutation = m_historyMutationRevisions.find(boundSession);
                        if (mutation != m_historyMutationRevisions.end() && mutationRevision > mutation->projected) {
                            // A later preserving read can satisfy this mutation, but cannot
                            // revive rows from before it, even after a failed projection.
                            mutation->projected = mutationRevision;
                            preserveHistory = false;
                        }
                        transcript.configureHistory(fileIds, fallback, preserveHistory, preserveHistory);
                        transcript.preserveDiagnosticsSince(load->diagnosticRevision, previous);
                        if (settledDuringLoad) transcript.trimToTurns(50);
                        latest->refreshFileVersion();
                        agentruntime::flushMessages(*latest, hooksFor(*latest));
                        finishProjectionLoad(agentId, ticket, true);
                    };
                    if (!projection.fileIds.isEmpty()) {
                        apply(projection.fileIds, true);
                    } else if (!latest->tab().sessionPath.isEmpty()) {
                        // Older pi implementations may not implement get_entries. Keep a
                        // numeric cursor from the complete file branch without blocking the
                        // event loop or assigning unverified entry ids to the RPC messages.
                        const QString path = projectionFilePath(latest->tab().sessionPath,
                            latest->tab().sessionEnvironment, latest->tab().wslDistro);
                        background::runBlocking([path, raw, hasEntries, legacyCursor]() {
                            const JsonlIndex index = jsonlindex::build(path);
                            QJsonArray ids;
                            for (const IndexEntry &entry : index.activeMessageEntries) ids.append(entry.id);
                            const int checkpointHead = !hasEntries && !legacyCursor ? legacyCheckpointHead(index, raw) : -1;
                            return QJsonValue(QJsonObject{{QStringLiteral("ids"), ids},
                                                          {QStringLiteral("checkpointHead"), checkpointHead}});
                        }, [apply](background::Outcome outcome) {
                            const QJsonObject data = outcome.value.toObject();
                            QStringList ids;
                            if (outcome.ok) {
                                for (const QJsonValue &id : data.value(QStringLiteral("ids")).toArray()) ids.append(id.toString());
                            }
                            apply(ids, outcome.ok, data.value(QStringLiteral("checkpointHead")).toInt(-1));
                        });
                    } else {
                        apply({}, false);
                    }
                });
        });
}

} // namespace runtime
