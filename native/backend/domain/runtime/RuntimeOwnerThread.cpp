/**
 * Owner-thread marshalling for the runtime domain (CAT-2).
 *
 * Why this file exists: every runtime object (`AgentSession`, its `PiEventClient`, the
 * `QProcess` below it, the agent table, the binding table and the session tree guard) is
 * single-threaded state owned by the Qt main thread. The serial domain executor also
 * serves `sessions:catalog-*` bodies, and those used to call straight into the coordinator:
 * a rename wrote `m_pending` + `QProcess::write` from the executor thread, and the archive /
 * delete guard iterated `m_agents` there. Both are data races on Qt containers and on a
 * QProcess that belongs to another thread.
 *
 * The rule is now explicit: off-thread callers use `postToOwner(...)` (or the two marshalled
 * helpers below) and continue in their callback, so the runtime is only ever touched from
 * the thread that created it.
 */
#include "RuntimeCoordinator.h"

#include "../MainCopy.h"

#include <QJsonObject>
#include <QThread>

#include <utility>

namespace runtime {
namespace {

/** Localized rename failure (`mainAgent.renameFailed`), with the raw detail in the log only. */
QString renameFailure(const maincopy::Translator &translate, const QString &detail)
{
    if (translate) return translate(QStringLiteral("mainAgent.renameFailed"), QJsonObject{});
    Q_UNUSED(detail);
    return QStringLiteral("Failed to rename the session. Try again.");
}

} // namespace

bool Coordinator::onOwnerThread() const
{
    return QThread::currentThreadId() == m_ownerThreadId;
}

void Coordinator::postToOwner(std::function<void()> task)
{
    if (!task) return;
    if (onOwnerThread()) {
        // Already the owner: running inline keeps the caller's ordering (a channel body
        // that asks for two verdicts must not see them reordered through the event loop).
        task();
        return;
    }
    if (m_shutdown) return;
    if (m_deps.post) {
        m_deps.post(std::move(task));
        return;
    }
    // No event loop to post into (a bare coordinator in a unit test). There is no owner
    // thread to protect in that shape either, so running here is the only meaningful
    // behaviour.
    task();
}

void Coordinator::sessionTreeBlockAsync(const QString &sessionId,
                                        std::function<void(const QJsonObject &)> done)
{
    postToOwner([this, sessionId = QString(sessionId), done = std::move(done)]() mutable {
        if (m_shutdown) {
            if (done) done(QJsonObject{});
            return;
        }
        const QJsonObject block = findSessionTreeBlock(sessionId);
        if (done) done(block);
    });
}

void Coordinator::renameRuntimeAsync(const QString &sessionId, const QString &name,
                                    std::function<void(RenameOutcome, const QString &)> done)
{
    postToOwner([this, sessionId = QString(sessionId), name = QString(name),
                 done = std::move(done)]() mutable {
        if (m_shutdown) {
            if (done) done(RenameOutcome::Failed, QStringLiteral("Session runtime is not available"));
            return;
        }
        const QString agentId = m_bindings.agentForSession(sessionId);
        AgentSession *session = agentId.isEmpty() ? nullptr : agent(agentId);
        if (!session || !session->running()) {
            // No live runtime: the caller renames the session file instead (oracle: the
            // `SessionRecordService.update` fallback).
            if (done) done(RenameOutcome::NoRuntime, QString());
            return;
        }
        const maincopy::Translator translate = m_deps.services ? m_deps.services->translate
                                                             : maincopy::Translator{};
        // pi owns the session file, so a live rename must go through `set_session_name`;
        // the oracle awaits it with a 20 s budget and treats a refusal as a failure.
        session->request(
            QStringLiteral("set_session_name"), QJsonObject{{QStringLiteral("name"), name}}, 20'000,
            [this, sessionId, agentId, name, done, translate](bool ok, const QJsonObject &response,
                                                             const QString &failure) mutable {
                AgentSession *current = agent(agentId);
                // Fence: a replacement (fork/clone) or a rebind while the RPC was in flight
                // means this answer belongs to a runtime the renderer no longer targets.
                if (!current || m_bindings.agentForSession(sessionId) != agentId) {
                    if (done) done(RenameOutcome::Failed, renameFailure(translate, QStringLiteral("runtime replaced")));
                    return;
                }
                if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                    QString detail = response.value(QStringLiteral("error")).toString();
                    if (detail.isEmpty()) detail = failure;
                    if (done) done(RenameOutcome::Failed, renameFailure(translate, detail));
                    return;
                }
                current->tab().title = name;
                emitState();
                if (done) done(RenameOutcome::Renamed, QString());
            });
    });
}

} // namespace runtime
