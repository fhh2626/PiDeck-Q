#include "RuntimeCoordinator.h"

#include "DeliveryBudget.h"
#include "PiLaunch.h"
#include "SessionFileMutations.h"

#include "../sessions/SessionCatalogStore.h"
#include "../sessions/SessionScanner.h"
#include "../process/TextEncoding.h"
#include "../transport/EventHub.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QThread>
#include <QTimer>
#include <QUuid>

#include <algorithm>
#include <stdexcept>

namespace runtime {
namespace {

constexpr int kStateTimeoutMs = 30'000;
constexpr int kMessagesTimeoutMs = 120'000;
constexpr int kEntriesTimeoutMs = 15'000;
constexpr int kCommandTimeoutMs = 60'000;
constexpr int kLongCommandTimeoutMs = 120'000;
constexpr int kDeliveryTtlMs = 10 * 60 * 1000;
constexpr int kDeliveryMaxEntries = 500;

qint64 nowMs()
{
    return QDateTime::currentMSecsSinceEpoch();
}

std::runtime_error failure(const QString &message)
{
    // std::string must not cross the Qt ABI (see process/TextEncoding.h).
    return textenc::error(message);
}

} // namespace

Coordinator::Coordinator(Deps deps)
    : m_deps(std::move(deps)), m_ownerThreadId(QThread::currentThreadId())
{
}

Coordinator::~Coordinator()
{
    shutdown();
}

void Coordinator::shutdown()
{
    if (m_shutdown) return;
    m_shutdown = true;
    // Deferred refresh callbacks belong to this runtime graph and cannot outlive it.
    m_projectionLoads.clear();
    m_compactProjectionExits.clear();
    m_pendingUi.clear();
    for (auto &entry : m_delivery) {
        if (!entry.settled) {
            entry.settled = true;
            entry.result = errorResult(CommandError::of(errorcode::kRuntimeUnavailable,
                                                        QStringLiteral("Backend is shutting down")));
            for (const auto &waiter : entry.waiters) waiter(entry.result);
            entry.waiters.clear();
        }
    }
    for (auto &entry : m_agents) {
        entry.second->close();
        if (m_deps.disposeRpcLog) m_deps.disposeRpcLog(entry.first);
    }
    m_agents.clear();
    m_bindings = Bindings();
}

void Coordinator::forgetAgent(const QString &agentId)
{
    m_agents.erase(agentId);
    const auto pendingProjection = m_projectionLoads.constFind(agentId);
    if (pendingProjection != m_projectionLoads.cend()) {
        finishProjectionLoad(agentId, pendingProjection->ticket);
    }
    // The runtime-kind flag is per agent id (oracle `rustRuntimeAgents` is cleared with the
    // agent), and every runtime gets a fresh id, so it can never leak to another process.
    m_rustRuntimeAgents.remove(agentId);
    // Oracle `clearAgentState`: the recording gate is per runtime, so a stopped agent
    // must not keep accepting frames or leave batches queued for delivery.
    if (m_deps.disposeRpcLog) m_deps.disposeRpcLog(agentId);
}

void Coordinator::clearAgentRuntimeState(AgentSession &session)
{
    const QString agentId = session.tab().id;
    // 1. Subagent rows: publish the empty snapshot *first* (oracle comment on
    //    `subagentRuns.clearAgent`). The exit path does not always emit a detach frame, and
    //    the renderer only clears a child dot when it receives `runs: []`.
    if (!session.subagentRuns().snapshot(nowMs()).isEmpty()) {
        emitForAgent(agentId, QStringLiteral("agents:subagent-status"),
                     QJsonObject{{QStringLiteral("agentId"), agentId},
                                 {QStringLiteral("runs"), QJsonArray{}}});
    }
    session.subagentRuns().clear();
    // 2. Interactive requests: the process that asked is gone, so `ui-response` for these
    //    ids must fail as unknown instead of being written to a dead pipe.
    session.pendingUi().clear();
    const QString sessionId = m_bindings.sessionForAgent(agentId);
    if (!sessionId.isEmpty()) clearPendingUi(sessionId);
    // 3. Live accumulators and the local streaming/tool flags. The oracle clears them
    //    through `setStreamingAgent(false)`, which publishes the flag patch only when the
    //    flag actually changed; without it a crash mid-reply leaves the last
    //    `isStreaming:true` state in the renderer and the stop/spinner UI never settles.
    const bool wasStreaming = session.tab().isStreaming;
    const bool wasExecutingTool = session.tab().isExecutingTool;
    session.liveChannels().reset();
    session.perf().clear();
    session.transcript().clearThinking();
    session.transcript().clearToolIds();
    session.activeToolCalls().clear();
    session.tab().isStreaming = false;
    session.tab().isExecutingTool = false;
    session.tab().executingToolName.clear();
    if ((wasStreaming || wasExecutingTool) && !sessionId.isEmpty()) {
        // Same payload as `emitStreamingStatePatch`: the renderer merges `state` into its
        // runtime state atom, so no RPC round-trip is needed to settle the badges.
        emitForAgent(agentId, QStringLiteral("agents:runtime-state"),
                     QJsonObject{{QStringLiteral("agentId"), agentId},
                                 {QStringLiteral("state"),
                                  QJsonObject{
                                      {QStringLiteral("isStreaming"), false},
                                      {QStringLiteral("isExecutingTool"), false},
                                      {QStringLiteral("toolStateSequence"),
                                       session.tab().toolStateSequence},
                                  }}});
    }
    // 4. The one-shot clean-exit reconnect guard is per exit, not per runtime: the oracle
    //    deletes it here so a runtime the user restarts by hand may reconnect again.
    session.setAutoRestartAttempted(false);
}

AgentSession *Coordinator::agent(const QString &agentId) const
{
    const auto found = m_agents.find(agentId);
    return found == m_agents.end() ? nullptr : found->second.get();
}

AgentSession *Coordinator::requireAgent(const QString &agentId) const
{
    AgentSession *session = agent(agentId);
    if (!session) throw failure(QStringLiteral("Session runtime is not available"));
    return session;
}

void Coordinator::stopAgent(const QString &agentId, std::function<void(QJsonObject)> done)
{
    const QString sessionId = m_bindings.sessionForAgent(agentId);
    if (sessionId.isEmpty()) {
        done(errorResult(CommandError::of(errorcode::kRuntimeUnavailable,
                                          QStringLiteral("Session runtime is not available"))));
        return;
    }
    Target target;
    target.sessionId = sessionId;
    target.agentId = agentId;
    target.runtimeGeneration = m_bindings.generationForSession(sessionId);
    stop(QJsonObject{
             {QStringLiteral("sessionId"), target.sessionId},
             {QStringLiteral("agentId"), target.agentId},
             {QStringLiteral("runtimeGeneration"), target.runtimeGeneration},
         },
         std::move(done));
}

void Coordinator::setFocusedSession(const QString &sessionId)
{
    m_focusedSessionId = sessionId;
}

void Coordinator::resyncLiveState()
{
    if (m_shutdown) return;
    // Order matters: the tab table first, then each agent's message window, so a renderer
    // applying both frames ends up with a self-consistent view. Only *bound* agents are
    // pushed, so a resync can never resurrect a session the user already stopped.
    emitState();
    for (const auto &entry : m_agents) {
        AgentSession *session = entry.second.get();
        if (!session) continue;
        QString sessionId;
        int generation = 0;
        if (!m_bindings.bindingForAgent(entry.first, &sessionId, &generation)) continue;
        agentruntime::flushMessages(*session, hooksFor(*session));
    }
}

void Coordinator::respondTrustRequest(const QString &requestId, const QString &choice)
{
    // The pending prompt lives in the projects domain (TrustBroker); the coordinator only
    // forwards the renderer's answer so the channel surface stays in one place.
    if (m_deps.respondTrust) m_deps.respondTrust(requestId, choice);
}

QString Coordinator::deliveryKey(const QString &sessionId, const QString &requestId) const
{
    return sessionId + QLatin1Char('\0') + requestId;
}

void Coordinator::pruneDelivery()
{
    const qint64 now = nowMs();
    for (auto iterator = m_delivery.begin(); iterator != m_delivery.end();) {
        if (iterator->settled && now - iterator->createdAt > kDeliveryTtlMs) {
            iterator = m_delivery.erase(iterator);
        } else {
            ++iterator;
        }
    }
    if (m_delivery.size() <= kDeliveryMaxEntries) return;
    for (auto iterator = m_delivery.begin(); iterator != m_delivery.end()
         && m_delivery.size() > kDeliveryMaxEntries;) {
        if (!iterator->settled) {
            ++iterator;
            continue;
        }
        iterator = m_delivery.erase(iterator);
    }
}

void Coordinator::settleDelivery(const QString &key, const QJsonObject &result)
{
    auto found = m_delivery.find(key);
    if (found == m_delivery.end()) return;
    found->settled = true;
    found->result = result;
    const auto waiters = found->waiters;
    found->waiters.clear();
    for (const auto &waiter : waiters) waiter(result);
}

bool Coordinator::requireTarget(const QJsonObject &targetJson, Target *out, CommandError *error) const
{
    Target target;
    target.sessionId = targetJson.value(QStringLiteral("sessionId")).toString();
    target.agentId = targetJson.value(QStringLiteral("agentId")).toString();
    target.runtimeGeneration = targetJson.value(QStringLiteral("runtimeGeneration")).toInt();
    if (target.sessionId.isEmpty() || target.agentId.isEmpty()) {
        *error = CommandError::of(errorcode::kRuntimeUnavailable,
                                  QStringLiteral("Session runtime target is required"));
        return false;
    }
    CatalogEntry entry;
    if (!m_deps.services || !m_deps.services->catalog
        || !m_deps.services->catalog->get(target.sessionId, &entry)) {
        *error = CommandError::of(errorcode::kSessionNotFound,
                                  QStringLiteral("Session not found: %1").arg(target.sessionId));
        return false;
    }
    const QString boundAgent = m_bindings.agentForSession(target.sessionId);
    if (boundAgent.isEmpty()) {
        *error = CommandError::of(errorcode::kRuntimeUnavailable,
                                  QStringLiteral("Session runtime is not available"));
        return false;
    }
    // A different agent or generation means the runtime was replaced: the renderer
    // must re-activate instead of retrying against a process that no longer exists.
    const int generation = m_bindings.generationForSession(target.sessionId);
    if (boundAgent != target.agentId || generation != target.runtimeGeneration) {
        *error = CommandError::of(errorcode::kRuntimeChanged,
                                  QStringLiteral("Session runtime binding changed"));
        return false;
    }
    if (out) *out = target;
    return true;
}

void Coordinator::runTarget(
    const QJsonObject &targetJson,
    std::function<void(AgentSession &, const Target &, CommandDone)> operation,
    std::function<void(QJsonObject)> done)
{
    Target target;
    CommandError error;
    if (!requireTarget(targetJson, &target, &error)) {
        done(errorResult(error));
        return;
    }
    quint64 lease = 0;
    try {
        lease = m_bindings.acquireLease(target);
    } catch (const std::exception &failure) {
        done(errorResult(classifyFailure(QString::fromUtf8(failure.what()))));
        return;
    }
    AgentSession *session = agent(target.agentId);
    if (!session) {
        m_bindings.releaseLease(lease);
        done(errorResult(CommandError::of(errorcode::kRuntimeUnavailable,
                                          QStringLiteral("Session runtime is not available"))));
        return;
    }
    operation(*session, target, [this, lease, target, done](bool ok, const QJsonValue &value,
                                                            const QString &message) {
        const bool current = m_bindings.leaseCurrent(lease);
        m_bindings.releaseLease(lease);
        if (!ok) {
            done(errorResult(classifyFailure(message)));
            return;
        }
        if (!current) {
            done(errorResult(CommandError::of(
                errorcode::kRuntimeChanged,
                QStringLiteral("Session runtime binding changed during command dispatch"))));
            return;
        }
        done(targetedOk(target, value));
    });
}

void Coordinator::queueHistoryMutation(const QString &sessionId,
                                       std::function<void(std::function<void()>)> task)
{
    QVector<std::function<void(std::function<void()>)>> &queue = m_historyTails[sessionId];
    queue.append(std::move(task));
    // The running task drains the queue when it finishes; only the first entry starts now.
    if (queue.size() == 1) startNextHistoryMutation(sessionId);
}

void Coordinator::startNextHistoryMutation(const QString &sessionId)
{
    auto found = m_historyTails.find(sessionId);
    if (found == m_historyTails.end()) return;
    if (found->isEmpty()) {
        m_historyTails.erase(found);
        return;
    }
    const auto task = found->takeFirst();
    task([this, sessionId]() { startNextHistoryMutation(sessionId); });
}

void Coordinator::runHistoryMutation(
    const QJsonObject &targetJson,
    std::function<void(AgentSession &, const Target &, CommandDone)> operation,
    std::function<void(QJsonObject)> done)
{
    const QString sessionId = targetJson.value(QStringLiteral("sessionId")).toString();
    queueHistoryMutation(sessionId, [this, targetJson, operation, done](std::function<void()> finished) {
        runTarget(targetJson, operation, [done, finished](QJsonObject result) {
            done(result);
            finished();
        });
    });
}

} // namespace runtime
