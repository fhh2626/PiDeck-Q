#include "RuntimeCoordinator.h"

#include "PiLaunch.h"
#include "../pi/PiLocator.h"
#include "../sessions/SessionCatalogStore.h"

#include <utility>

/**
 * pi process swap for one existing runtime (oracle `AgentManager.reattachProcess`).
 *
 * Some pi builds exit at the end of a compaction and then expect to be restarted on the
 * same session file. The desktop contract is that this is invisible: the agentId, its
 * runtime generation, the tab identity and the transcript all stay, only the stdio
 * transport is replaced. Unbinding instead (the generic exit path) would force a new
 * generation for a session the user never closed and drop the compaction's result.
 */
namespace runtime {
namespace {

constexpr int kStateTimeoutMs = 30'000;

} // namespace

pilaunch::Request Coordinator::sessionLaunchRequest(const AgentSession &session,
                                                    const QString &sessionPath) const
{
    pilaunch::Request request;
    request.settings = m_deps.settings ? m_deps.settings() : QJsonObject{};
    request.resourcesDir = m_deps.resourcesDir;
    request.projectPath = session.tab().cwd;
    request.sessionPath = sessionPath;
    request.noSession = session.tab().noSession;
    request.securitySessionId = session.tab().deckSessionId;
    request.securitySnapshotPath = m_deps.securitySnapshotPath;
    request.uiLocale = m_deps.uiLocale ? m_deps.uiLocale() : QString();
    request.wslExe = m_deps.services ? m_deps.services->wslExe : QString();
    return request;
}

pilaunch::Launch Coordinator::buildSessionLaunch(const AgentSession &session,
                                                 const QString &sessionPath) const
{
    pilaunch::Request request = sessionLaunchRequest(session, sessionPath);
    const QString version = pilaunch::cachedVersion(pilaunch::build(request));
    request.approveProjectResources = pilaunch::supportsProjectApprovalFlag(version);
    const QString kind = pilocator::detectRuntimeKind(version);
    if (kind != QLatin1String("unknown")) {
        request.detectedRuntimeKind = kind == QLatin1String("typescript") ? QStringLiteral("ts") : kind;
    }
    return pilaunch::build(request);
}

void Coordinator::finishReattach(const QString &agentId, quint64 ticket, bool ok,
                                 const QString &error, quint64 attemptEpoch)
{
    auto attempt = m_reattachAttempts.find(agentId);
    if (attempt == m_reattachAttempts.end() || attempt->ticket != ticket) return;
    auto completion = std::move(attempt->completion);
    // Completion may synchronously stop or reactivate the session. It must never
    // erase a later attempt or be reached again by this transport's late callbacks.
    m_reattachAttempts.erase(attempt);
    completion(ok, error, attemptEpoch);
}

void Coordinator::reattachProcess(const QString &agentId, const Target &target,
                                  std::function<void(bool ok, const QString &error, quint64 attemptEpoch)> done)
{
    AgentSession *session = agent(agentId);
    if (!session) {
        done(false, QStringLiteral("Session runtime is not available"), 0);
        return;
    }
    if (m_shutdown) {
        done(false, QStringLiteral("Backend is shutting down"), 0);
        return;
    }
    QString boundSession;
    int generation = 0;
    if (agentId != target.agentId || !m_bindings.bindingForAgent(agentId, &boundSession, &generation)
        || boundSession != target.sessionId || generation != target.runtimeGeneration) {
        done(false, QStringLiteral("Session runtime binding changed"), 0);
        return;
    }
    if (m_reattachAttempts.contains(agentId)) {
        done(false, QStringLiteral("Session runtime reconnect is already in progress"), 0);
        return;
    }
    CatalogEntry entry;
    if (!m_deps.services || !m_deps.services->catalog
        || !m_deps.services->catalog->get(target.sessionId, &entry)) {
        done(false, QStringLiteral("Session not found: %1").arg(target.sessionId), session->clientEpoch());
        return;
    }
    const quint64 expectedEpoch = session->clientEpoch();
    pilaunch::Request request = sessionLaunchRequest(*session, session->tab().sessionPath);
    // A reconnect preserves its generation and the compact command's dispatch lease.
    // Its separate ticket reserves deletion admission without disabling explicit stop.
    const quint64 ticket = ++m_nextReattachTicket;
    m_reattachAttempts.insert(agentId, ReattachAttempt{ticket, std::move(done)});
    auto finish = [this, agentId, ticket](bool ok, const QString &error, quint64 attemptEpoch) {
        finishReattach(agentId, ticket, ok, error, attemptEpoch);
    };
    // Settings can select a new command while the existing runtime is alive. Probe the
    // captured command so a cold cache cannot silently drop its project resources.
    pilaunch::probeVersion(pilaunch::build(request), m_versionProbes,
        [this, agentId, target, expectedEpoch, entry, request, ticket, finish](const QString &version) mutable {
            const auto attempt = m_reattachAttempts.constFind(agentId);
            if (attempt == m_reattachAttempts.cend() || attempt->ticket != ticket) return;
            request.approveProjectResources = pilaunch::supportsProjectApprovalFlag(version);
            const QString kind = pilocator::detectRuntimeKind(version);
            if (kind != QLatin1String("unknown")) {
                request.detectedRuntimeKind = kind == QLatin1String("typescript") ? QStringLiteral("ts") : kind;
            }
            reattachPrepared(agentId, target, expectedEpoch, entry, request, pilaunch::build(request), finish);
        });
}

void Coordinator::reattachPrepared(const QString &agentId, const Target &target, quint64 expectedEpoch,
                                   const CatalogEntry &entry, const pilaunch::Request &request,
                                   const pilaunch::Launch &launch,
                                   std::function<void(bool ok, const QString &error, quint64 attemptEpoch)> done)
{
    AgentSession *session = agent(agentId);
    if (!session) {
        done(false, QStringLiteral("Session runtime is not available"), 0);
        return;
    }
    // Declaration fence: the swap must only revive the *same* runtime. A stop/restart
    // that landed between the exit and this callback owns the binding now, and spawning
    // a second pi for it would resurrect a process the user already closed.
    QString boundSession;
    int generation = 0;
    if (!m_bindings.bindingForAgent(agentId, &boundSession, &generation)
        || boundSession != target.sessionId || generation != target.runtimeGeneration) {
        done(false, QStringLiteral("Session runtime binding changed"), 0);
        return;
    }
    const QString &sessionPath = request.sessionPath;
    if (session->clientEpoch() != expectedEpoch || session->tab().sessionPath != sessionPath) {
        done(false, QStringLiteral("Session runtime changed during reconnect"), 0);
        return;
    }
    if (m_shutdown || deletionBlocks(target.sessionId) || deletionBlocksAgent(agentId)) {
        // The binding still owns this exited transport. Its epoch lets callers
        // retire it instead of leaving a dead runtime stuck in starting state.
        done(false, QStringLiteral("Session deletion is in progress"), session->clientEpoch());
        return;
    }
    const QString identityError = launchIdentityError(entry, request.projectPath);
    if (!identityError.isEmpty()) {
        done(false, identityError, expectedEpoch);
        return;
    }
    if (sessionPath.isEmpty()) {
        // Without a session file a second process would start an empty conversation.
        done(false, QStringLiteral("Session has no session file to reattach"), session->clientEpoch());
        return;
    }

    CatalogEntry previous;
    previous.filePath = sessionPath;
    previous.environment = session->tab().sessionEnvironment;
    previous.wslDistro = session->tab().wslDistro;
    previous.wslUser = session->tab().wslUser;
    const CatalogEntry actual = deletionidentity::forLaunch(previous, launch);
    if (deletionBlocksLaunch(previous) || deletionBlocksLaunch(actual)) {
        done(false, QStringLiteral("Session deletion is in progress"), session->clientEpoch());
        return;
    }
    if (!deletionidentity::compatibleLaunch(previous, actual) || deletionBlocksEntry(actual)) {
        done(false, QStringLiteral("Session runtime environment changed during reconnect"), session->clientEpoch());
        return;
    }
    // A user switch stays in the same filesystem namespace, but the tab must name
    // the actual launch context rather than preserving obsolete catalog metadata.
    session->tab().wslUser = actual.wslUser;
    session->tab().wslDistro = actual.wslDistro;
    QString spawnError;
    if (!session->reattach(launch, &spawnError)) {
        done(false, spawnError, session->clientEpoch());
        return;
    }

    const quint64 attemptEpoch = session->clientEpoch();
    // Dispose a failed attempt only after leaving its RPC callback stack, and only if
    // both the binding and the exact spawned transport still belong to this attempt.
    const auto finish = [this, agentId, target, attemptEpoch, done](bool ok, const QString &error) {
        if (ok || !m_deps.post) { done(ok, error, attemptEpoch); return; }
        m_deps.post([this, agentId, target, attemptEpoch, done, error]() {
            QString sessionId;
            int generation = 0;
            AgentSession *current = agent(agentId);
            if (current && current->clientEpoch() == attemptEpoch
                && m_bindings.bindingForAgent(agentId, &sessionId, &generation)
                && sessionId == target.sessionId && generation == target.runtimeGeneration) {
                current->setExitHandler({});
                current->kill();
            }
            done(false, error, attemptEpoch);
        });
    };
    session->request(
        QStringLiteral("get_state"), {}, kStateTimeoutMs,
        [this, agentId, target, attemptEpoch, done = finish](bool ok, const QJsonObject &response, const QString &error) {
            AgentSession *current = agent(agentId);
            if (!current || current->clientEpoch() != attemptEpoch) {
                done(false, QStringLiteral("Session runtime stopped during reconnect"));
                return;
            }
            if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                const QString failure = !error.isEmpty()
                    ? error
                    : response.value(QStringLiteral("error")).toString(
                          QStringLiteral("pi get_state failed after reconnect"));
                current->tab().status = QStringLiteral("closed");
                emitState();
                done(false, failure);
                return;
            }
            const QJsonObject data = response.value(QStringLiteral("data")).toObject();
            const QString projectPath = resolveProjectPath(current->tab().projectId);
            // pi may report the file it is now writing; a missing answer keeps the path
            // the reattach was started with (oracle `data?.sessionFile ?? sessionPath`).
            const QString reported = data.value(QStringLiteral("sessionFile")).toString();
            if (!reported.isEmpty()) {
                current->tab().sessionPath = normalizeSessionPath(reported, projectPath);
            }
            if (deletionBlocksAgent(agentId)) {
                done(false, QStringLiteral("Session deletion is in progress"));
                return;
            }
            if (data.value(QStringLiteral("sessionId")).isString()) {
                current->tab().piSessionId = data.value(QStringLiteral("sessionId")).toString();
            }
            const QString name = data.value(QStringLiteral("sessionName")).toString();
            if (!name.isEmpty()) current->tab().title = name;
            // Reconnected == pi accepts messages again, so the whole compaction gate can
            // drop (oracle deletes `rpcCompactingAgents` right here).
            current->setManualCompactionEvent(false);
            // `reattachProcess` success re-arms the clean-exit reconnect for the next time
            // (oracle `autoRestartAttempted.delete(agentId)` in the same block).
            current->setAutoRestartAttempted(false);
            current->tab().status = QStringLiteral("idle");
            // The compacted history lives in the session file: reload through the same
            // projection path the runtime always uses (and flush, so the renderer replaces
            // its window instead of keeping pre-compaction rows).
            loadProjection(*current, [this, agentId, target, attemptEpoch, done](bool projected) {
                AgentSession *latest = agent(agentId);
                if (!projected || !latest || latest->clientEpoch() != attemptEpoch || !latest->running()) {
                    done(false, QStringLiteral("Session projection unavailable after reattach"));
                    return;
                }
                QString boundSession;
                int generation = 0;
                if (!m_bindings.bindingForAgent(agentId, &boundSession, &generation)
                    || boundSession != target.sessionId || generation != target.runtimeGeneration) {
                    done(false, QStringLiteral("Session runtime binding changed"));
                    return;
                }
                try { persistRuntimeIdentity(target.sessionId, *latest); }
                catch (const std::exception &failure) {
                    done(false, QString::fromUtf8(failure.what()));
                    return;
                }
                latest->refreshFileVersion();
                emitState();
                done(true, QString());
            }, true);
        });
}

void Coordinator::discardFailedReattach(const Target &target, quint64 attemptEpoch)
{
    AgentSession *current = agent(target.agentId);
    QString sessionId;
    int generation = 0;
    if (!current || attemptEpoch == 0 || current->clientEpoch() != attemptEpoch
        || !m_bindings.bindingForAgent(target.agentId, &sessionId, &generation)
        || sessionId != target.sessionId || generation != target.runtimeGeneration) return;

    current->tab().status = QStringLiteral("closed");
    clearAgentRuntimeState(*current);
    emitDetach(target);
    m_bindings.unbind(target.agentId);
    if (m_deps.disposeRpcLog) m_deps.disposeRpcLog(target.agentId);
    emitState();
    // Completion can still be on a transport callback stack. Retire on the next
    // loop turn and recheck both fences in case a newer owner arrived meanwhile.
    if (m_deps.post) m_deps.post([this, target, attemptEpoch]() {
        AgentSession *failed = agent(target.agentId);
        QString reboundSession;
        int reboundGeneration = 0;
        if (!failed || failed->clientEpoch() != attemptEpoch
            || m_bindings.bindingForAgent(target.agentId, &reboundSession, &reboundGeneration)) return;
        failed->setExitHandler({});
        failed->close();
        forgetAgent(target.agentId);
        emitState();
    });
}

} // namespace runtime
