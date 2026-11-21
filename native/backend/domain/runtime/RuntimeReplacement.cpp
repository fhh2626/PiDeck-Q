#include "RuntimeCoordinator.h"

#include "../sessions/SessionCatalogStore.h"

namespace runtime {
namespace {

constexpr int kStateTimeoutMs = 30'000;
constexpr int kLongCommandTimeoutMs = 120'000;

} // namespace

/**
 * Reserve, run, and settle a runtime replacement (fork/clone).
 *
 * Port of `SessionRuntimeCoordinator.replaceBoundRuntime`: the reservation happens
 * *before* the pi call so a concurrent prompt cannot dispatch into the process whose
 * identity is being replaced, pending interactive requests are dropped (their process may
 * answer with a brand-new session), and a rejection (`cancelled`) puts the original
 * binding back instead of leaving the session unbound.
 */
void Coordinator::runReplacement(const Target &target, const QString &command,
                                 const QJsonObject &params,
                                 std::function<void(QJsonObject)> done)
{
    AgentSession *session = agent(target.agentId);
    if (!session) {
        done(errorResult(CommandError::of(errorcode::kRuntimeUnavailable,
                                          QStringLiteral("Session runtime is not available"))));
        return;
    }
    // The destination is not known until pi has already written the replacement.
    // Resolve ordinary commands narrowly, but do not start an unprovable path change.
    if (deletionBlocksPathChange(target.agentId)) {
        done(errorResult(CommandError::of(errorcode::kRuntimeChanged,
                                          QStringLiteral("Session deletion is in progress"))));
        return;
    }
    // Publish any completed rows before the reservation hides the original target.
    session->liveChannels().flushPendingCompletedRows();
    Bindings::Reservation reservation;
    try {
        reservation = m_bindings.beginReplacement(target.sessionId, target.agentId);
    } catch (const std::exception &failure) {
        done(errorResult(classifyFailure(QString::fromUtf8(failure.what()))));
        return;
    }
    if (!reservation.valid) {
        done(errorResult(CommandError::of(errorcode::kRuntimeChanged,
                                          QStringLiteral("Session runtime binding changed"))));
        return;
    }
    // The oracle signals the detach with the *reserved* generation (binding + 1), because
    // that is the identity every later event of this replacement will carry.
    Target detached = reservation.previous;
    detached.runtimeGeneration = reservation.reservedGeneration;
    emitDetach(detached);
    clearPendingUi(target.sessionId);

    const QString agentId = target.agentId;
    session->request(command, params, kLongCommandTimeoutMs,
                     [this, target, agentId, done](bool ok, const QJsonObject &response,
                                                   const QString &error) {
                         if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                             restoreReplacement(target);
                             done(errorResult(classifyFailure(
                                 error.isEmpty()
                                     ? response.value(QStringLiteral("error")).toString(
                                           QStringLiteral("%1 failed").arg(QStringLiteral("pi")))
                                     : error)));
                             return;
                         }
                         const QJsonObject data = response.value(QStringLiteral("data")).toObject();
                         if (data.value(QStringLiteral("cancelled")).toBool(false)) {
                             // pi kept the original session: put the binding back, exactly
                             // like the oracle's `restoreRuntimeReplacement`.
                             restoreReplacement(target);
                             done(okResult(QJsonObject{{QStringLiteral("cancelled"), true}}));
                             return;
                         }
                         refreshAfterReplacement(target, data, std::move(done));
                     });
}

void Coordinator::restoreReplacement(const Target &target)
{
    try {
        // Atomic: drop the reservation and put the original binding back in one step, so no
        // activation can slip into the gap and steal the session.
        completeReplacement(target.sessionId, target.agentId, target.sessionId, target.agentId);
    } catch (const std::exception &) {
        // The agent vanished meanwhile; the state event below still tells the renderer.
        m_bindings.finishReplacement(target.sessionId, target.agentId);
    }
    emitState();
}

void Coordinator::refreshAfterReplacement(const Target &target, const QJsonObject &data,
                                          std::function<void(QJsonObject)> finish)
{
    const QString agentId = target.agentId;
    AgentSession *session = agent(agentId);
    if (!session) {
        m_bindings.finishReplacement(target.sessionId, agentId);
        emitState();
        finish(errorResult(CommandError::of(
            errorcode::kRuntimeUnavailable,
            QStringLiteral("Session runtime stopped during replacement"))));
        return;
    }
    const QString projectPath = resolveProjectPath(session->tab().projectId);
    // pi reports the new file in the fork/clone response. When it does not (fake pi, or a
    // runtime whose session file was never written) the tab keeps its previous path, which
    // is exactly what the oracle's `resolveTargetSessionId` reads; `ensureRuntimeTarget`
    // then dedupes by origin key instead of minting a duplicate record.
    if (data.value(QStringLiteral("sessionFile")).isString()
        && !data.value(QStringLiteral("sessionFile")).toString().isEmpty()) {
        session->tab().sessionPath = normalizeSessionPath(
            data.value(QStringLiteral("sessionFile")).toString(), projectPath);
    }
    QString sessionPath = session->tab().sessionPath;
    if (data.value(QStringLiteral("sessionName")).isString()
        && !data.value(QStringLiteral("sessionName")).toString().isEmpty()) {
        session->tab().title = data.value(QStringLiteral("sessionName")).toString();
    }
    if (data.value(QStringLiteral("sessionId")).isString()) {
        session->tab().piSessionId = data.value(QStringLiteral("sessionId")).toString();
    }
    if (sessionPath.isEmpty()) {
        // Fail closed: the runtime identity cannot be proven, so no session may claim it.
        m_bindings.finishReplacement(target.sessionId, agentId);
        emitState();
        finish(errorResult(CommandError::of(
            errorcode::kCommandFailed,
            QStringLiteral("Replacement runtime has no session path: %1").arg(agentId))));
        return;
    }

    QString targetSessionId = target.sessionId;
    if (m_deps.services->catalog) {
        // The clone/fork wrote a new session file: it needs its own stable catalog identity.
        const CatalogEntry created = m_deps.services->catalog->ensureRuntimeTarget(
            session->tab().projectId, session->tab().title,
            session->tab().sessionSource.isEmpty() ? QStringLiteral("pi")
                                                   : session->tab().sessionSource,
            session->tab().sessionEnvironment, sessionPath, session->tab().wslDistro,
            session->tab().wslUser, session->tab().importedSourceId,
            session->tab().piSessionId);
        targetSessionId = created.id;
    }

    const QString boundAgent = m_bindings.agentForSession(targetSessionId);
    if (!boundAgent.isEmpty() && boundAgent != agentId) {
        // `completeRuntimeReplacement` refuses to steal a session that another live
        // runtime already owns.
        m_bindings.finishReplacement(target.sessionId, agentId);
        emitState();
        finish(errorResult(CommandError::of(
            errorcode::kCommandFailed,
            QStringLiteral("Session runtime target already bound: %1").arg(targetSessionId))));
        return;
    }

    int generation = 0;
    try {
        // Atomic commit: the reservation check, its release and the bind happen without a
        // yield, so the reported generation belongs to this replacement.
        generation = completeReplacement(target.sessionId, agentId, targetSessionId, agentId);
    } catch (const std::exception &failure) {
        m_bindings.finishReplacement(target.sessionId, agentId);
        emitState();
        finish(errorResult(classifyFailure(QString::fromUtf8(failure.what()))));
        return;
    }
    session->tab().runtimeGeneration = generation;
    loadProjection(*session, [this, agentId, generation, targetSessionId, data, finish](bool projected) {
        AgentSession *latest = agent(agentId);
        Target current;
        // Another replacement may reserve or replace this binding during projection.
        if (!m_bindings.targetForSession(targetSessionId, &current)
            || current.agentId != agentId || current.runtimeGeneration != generation) {
            finish(errorResult(CommandError::of(
                errorcode::kRuntimeChanged, QStringLiteral("Session runtime binding changed"))));
            return;
        }
        if (!projected || !latest || !latest->running()) {
            finish(errorResult(CommandError::of(
                errorcode::kRuntimeUnavailable,
                QStringLiteral("Session runtime stopped during replacement"))));
            return;
        }
        publishState(*latest);
        QJsonObject value = data;
        value.insert(QStringLiteral("targetSessionId"), targetSessionId);
        value.insert(QStringLiteral("agentId"), agentId);
        value.insert(QStringLiteral("runtimeGeneration"), generation);
        finish(okResult(value));
    });
}

void Coordinator::fork(const QJsonObject &targetJson, const QString &entryId,
                       std::function<void(QJsonObject)> done)
{
    Target resolved;
    CommandError error;
    if (!requireTarget(targetJson, &resolved, &error)) {
        done(errorResult(error));
        return;
    }
    runReplacement(resolved, QStringLiteral("fork"),
                   QJsonObject{{QStringLiteral("entryId"), entryId}}, std::move(done));
}

void Coordinator::clone(const QJsonObject &targetJson, std::function<void(QJsonObject)> done)
{
    Target resolved;
    CommandError error;
    if (!requireTarget(targetJson, &resolved, &error)) {
        done(errorResult(error));
        return;
    }
    runReplacement(resolved, QStringLiteral("clone"), QJsonObject{}, std::move(done));
}

} // namespace runtime
