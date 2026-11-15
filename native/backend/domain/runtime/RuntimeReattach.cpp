#include "RuntimeCoordinator.h"

#include "PiLaunch.h"

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

pilaunch::Launch Coordinator::buildSessionLaunch(const AgentSession &session,
                                                 const QString &sessionPath) const
{
    pilaunch::Request request;
    request.settings = m_deps.settings ? m_deps.settings() : QJsonObject{};
    request.agentDir = m_deps.agentDir;
    request.resourcesDir = m_deps.resourcesDir;
    request.projectPath = session.tab().cwd;
    request.sessionPath = sessionPath;
    request.noSession = session.tab().noSession;
    request.securitySessionId = session.tab().deckSessionId;
    request.securitySnapshotPath = m_deps.securitySnapshotPath;
    request.uiLocale = m_deps.uiLocale ? m_deps.uiLocale() : QString();
    request.wslExe = m_deps.services ? m_deps.services->wslExe : QString();
    bool hasTrustResources = false;
    request.trustOverride = pilaunch::resolveTrustOverride(m_deps.agentDir, request.projectPath,
                                                           &hasTrustResources);
    const pilaunch::Launch probe = pilaunch::build(request);
    if (request.trustOverride.isEmpty() || !hasTrustResources) return probe;
    // Trust flags only exist on pi >= 0.79. The version was probed when this runtime was
    // activated, so the cached answer decides here instead of forking `pi --version`
    // again in the middle of a reconnect.
    if (pilaunch::supportsTrustFlags(pilaunch::cachedVersion(probe))) return probe;
    request.trustOverride.clear();
    return pilaunch::build(request);
}

void Coordinator::reattachProcess(const QString &agentId, const Target &target,
                                  std::function<void(bool ok, const QString &error)> done)
{
    AgentSession *session = agent(agentId);
    if (!session) {
        done(false, QStringLiteral("Session runtime is not available"));
        return;
    }
    // Declaration fence: the swap must only revive the *same* runtime. A stop/restart
    // that landed between the exit and this callback owns the binding now, and spawning
    // a second pi for it would resurrect a process the user already closed.
    QString boundSession;
    int generation = 0;
    if (!m_bindings.bindingForAgent(agentId, &boundSession, &generation)
        || boundSession != target.sessionId || generation != target.runtimeGeneration) {
        done(false, QStringLiteral("Session runtime binding changed"));
        return;
    }
    const QString sessionPath = session->tab().sessionPath;
    if (sessionPath.isEmpty()) {
        // Without a session file a second process would start an empty conversation.
        done(false, QStringLiteral("Session has no session file to reattach"));
        return;
    }

    const pilaunch::Launch launch = buildSessionLaunch(*session, sessionPath);
    QString spawnError;
    if (!session->reattach(launch, &spawnError)) {
        done(false, spawnError);
        return;
    }

    session->request(
        QStringLiteral("get_state"), {}, kStateTimeoutMs,
        [this, agentId, done](bool ok, const QJsonObject &response, const QString &error) {
            AgentSession *current = agent(agentId);
            if (!current) {
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
            loadProjection(*current, [this, agentId, done]() {
                AgentSession *latest = agent(agentId);
                if (latest) {
                    latest->refreshFileVersion();
                    emitState();
                }
                done(true, QString());
            });
        });
}

} // namespace runtime
