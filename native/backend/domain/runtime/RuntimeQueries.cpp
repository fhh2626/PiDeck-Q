#include "RuntimeCoordinator.h"

#include "RuntimeTypes.h"
#include "../sessions/SessionCatalogStore.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>

#include <algorithm>
#include <stdexcept>

/**
 * Read-side projections of the runtime coordinator.
 *
 * Everything here answers a question about the *current* state (which runtime owns a
 * session, what the web client should render, which asks are pending, which processes are
 * alive) without starting work. Keeping them apart from the lifecycle/command plumbing is
 * what lets `RuntimeCoordinator.cpp` stay a coordinator instead of growing into a second
 * monolith: the channel layer only needs these getters, never the activation paths.
 */
namespace runtime {

QString Coordinator::resolveProjectPath(const QString &projectId) const
{
    if (!m_deps.services) return QString();
    try {
        return channels::resolveProjectPath(*m_deps.services, projectId);
    } catch (const std::exception &) {
        return QString();
    }
}

QString Coordinator::normalizeSessionPath(const QString &path, const QString &projectPath) const
{
    if (path.isEmpty()) return QString();
    // Linux resolves symlinks before '..'. Keep absolute POSIX spellings intact so
    // both pi and off-thread ownership resolution traverse the identical path.
    if (path.startsWith(QLatin1Char('/'))) return path;
    if (QFileInfo(path).isAbsolute()) return QDir::cleanPath(path);
    // pi may report a project-relative sessionFile; resolve it against the project so
    // the catalog never stores a relative path (that would duplicate on the next scan).
    return QDir::cleanPath(QDir(projectPath).filePath(path));
}

bool Coordinator::isSessionBusy(const QString &sessionId) const
{
    if (m_bindings.isActivating(sessionId) || m_bindings.isReplacingSession(sessionId)) return true;
    const QString agentId = m_bindings.agentForSession(sessionId);
    if (agentId.isEmpty()) return false;
    if (m_reattachAttempts.contains(agentId)) return true;
    const AgentSession *session = agent(agentId);
    return session && session->running();
}

QString Coordinator::launchIdentityError(const CatalogEntry &expected, const QString &projectPath) const
{
    if (m_shutdown) return QStringLiteral("Backend is shutting down");
    const QString currentProjectPath = resolveProjectPath(expected.projectId);
    if (currentProjectPath.isEmpty()) return QStringLiteral("Project not found: %1").arg(expected.projectId);
    if (currentProjectPath != projectPath) return QStringLiteral("Project path changed during runtime preparation");
    CatalogEntry current;
    if (!m_deps.services || !m_deps.services->catalog
        || !m_deps.services->catalog->get(expected.id, &current)) {
        return QStringLiteral("Session not found: %1").arg(expected.id);
    }
    // Deletion leases are temporary. A completed deletion or catalog retarget must
    // still invalidate a delayed launch after its lease has already been released.
    // Compare the captured catalog spelling without requiring a file for drafts.
    if (!deletionidentity::sameTarget(expected, current) || expected.noSession != current.noSession) {
        return QStringLiteral("Session runtime identity changed during preparation");
    }
    return QString();
}

QString Coordinator::runtimeSessionPath(const QString &sessionId) const
{
    const QString agentId = m_bindings.agentForSession(sessionId);
    if (agentId.isEmpty()) return QString();
    const AgentSession *session = agent(agentId);
    return session ? session->tab().sessionPath : QString();
}

QString Coordinator::liveToolFullText(const QString &sessionId, const QString &messageId) const
{
    if (messageId.isEmpty()) return QString();
    const QString agentId = m_bindings.agentForSession(sessionId);
    if (agentId.isEmpty()) return QString();
    AgentSession *session = agent(agentId);
    if (!session) return QString();
    return session->transcript().toolFullText(messageId);
}

QString Coordinator::runtimeAgentId(const QString &sessionId) const
{
    return m_bindings.agentForSession(sessionId);
}

QString Coordinator::sessionIdForAgent(const QString &agentId) const
{
    // The reverse lookup is what a legacy `pideck://agent/<id>` activation and a
    // secondary launch's argv need: they carry a runtime agent id, while the renderer
    // only indexes sessions by the catalog's stable id.
    return m_bindings.sessionForAgent(agentId);
}

bool Coordinator::validateTarget(const QJsonObject &target, QString *error) const
{
    CommandError failure;
    if (requireTarget(target, nullptr, &failure)) return true;
    if (error) *error = failure.debugDetails;
    return false;
}

QString Coordinator::agentCwd(const QString &agentId) const
{
    const AgentSession *session = agent(agentId);
    return session ? session->tab().cwd : QString();
}

QJsonArray Coordinator::agentProcesses() const
{
    QJsonArray processes;
    for (const auto &entry : m_agents) {
        const AgentSession &session = *entry.second;
        const qint64 pid = session.processId();
        if (pid <= 0) continue;
        const Tab &tab = session.tab();
        QJsonObject process{
            {QStringLiteral("agentId"), tab.id},
            {QStringLiteral("pid"), static_cast<double>(pid)},
        };
        if (!tab.deckSessionId.isEmpty()) process.insert(QStringLiteral("sessionId"), tab.deckSessionId);
        if (!tab.title.isEmpty()) process.insert(QStringLiteral("sessionTitle"), tab.title);
        processes.append(process);
    }
    return processes;
}

bool Coordinator::hasActiveStreaming() const
{
    for (const auto &entry : m_agents) {
        // Streaming state is maintained by the event projector (delta flags set it, the
        // terminal events clear it), so this never triggers a pi poll.
        if (entry.second && entry.second->tab().isStreaming) return true;
    }
    return false;
}

QJsonValue Coordinator::listRuntimes() const
{
    QJsonArray result;
    QVector<QJsonObject> items;
    for (const QString &sessionId : m_bindings.boundSessions()) {
        Target target;
        if (!m_bindings.targetForSession(sessionId, &target)) continue;
        const AgentSession *session = agent(target.agentId);
        if (!session) continue;
        // An idle but still bound runtime is part of the list: the renderer hydrates its
        // model/status/agent identity from here, and an idle runtime is exactly when a
        // reload happens. Only a closed process leaves the binding (separately).
        if (session->tab().status == QLatin1String("closed")) continue;
        items.append(runtimeInfoJson(target, session->tab()));
    }
    std::sort(items.begin(), items.end(), [](const QJsonObject &left, const QJsonObject &right) {
        return left.value(QStringLiteral("createdAt")).toDouble()
            > right.value(QStringLiteral("createdAt")).toDouble();
    });
    for (const QJsonObject &item : items) result.append(item);
    return result;
}

QJsonObject Coordinator::runtimeMessages(const QString &sessionId) const
{
    Target target;
    if (!m_bindings.targetForSession(sessionId, &target)) return QJsonObject{};
    const AgentSession *session = agent(target.agentId);
    if (!session) return QJsonObject{};
    // Same projection the desktop window is built from: the web client renders this
    // snapshot and then patches it from the event stream, so a second projection here
    // would drift from what the desktop tab shows.
    // Polling clients need the same cursor as SSE, but not its one-shot fields.
    QJsonObject window = session->transcript().windowMetadata();
    window.insert(QStringLiteral("historyMutationRevision"),
                  static_cast<double>(m_historyMutationRevisions.value(sessionId).projected));
    return QJsonObject{
        {QStringLiteral("target"),
         QJsonObject{
             {QStringLiteral("sessionId"), target.sessionId},
             {QStringLiteral("agentId"), target.agentId},
             {QStringLiteral("runtimeGeneration"), target.runtimeGeneration},
         }},
        {QStringLiteral("value"), session->transcript().messages()},
        {QStringLiteral("window"), window},
    };
}

QStringList Coordinator::activatingSessions() const
{
    return m_bindings.activatingSessions();
}

void Coordinator::observeUiRequest(const Target &target, const AgentSession::PendingUi &request)
{
    const QString key = deliveryKey(target.sessionId, request.requestId);
    m_pendingUi.insert(key, request);
    // A non-focused session asking a question must notify: the user is looking at
    // another session and would otherwise never see the prompt. SessionRuntimeCoordinator
    // does this before delegating the toast to AgentManager, which owns the settings gate
    // and the per-run dedupe.
    if (m_focusedSessionId == target.sessionId) return;
    if (!m_deps.notifyAskPending) return;
    AgentSession *session = agent(target.agentId);
    const QString title = session ? session->tab().title : QString();
    m_deps.notifyAskPending(target.agentId, title, request.title, target.sessionId);
}

void Coordinator::persistRuntimeIdentity(const QString &sessionId, const AgentSession &session)
{
    const Tab &tab = session.tab();
    if (tab.noSession || tab.sessionPath.isEmpty() || !m_deps.services || !m_deps.services->catalog) return;
    m_deps.services->catalog->attachRuntime(sessionId, tab.sessionPath, tab.piSessionId,
        SessionCatalogStore::RuntimeIdentity{tab.sessionEnvironment, tab.wslDistro, tab.wslUser});
}

int Coordinator::bindSession(const QString &sessionId, const QString &agentId)
{
    if (deletionBlocks(sessionId) || deletionBlocksAgent(agentId))
        throw ChannelError(QStringLiteral("Session deletion is in progress"));
    const int generation = m_bindings.bind(sessionId, agentId);
    // Oracle `bind` unconditionally drops this session's pending asks: after a rebind the
    // process that asked them is gone or has a new generation, so a late answer must not
    // be forwarded to the new runtime.
    clearPendingUi(sessionId);
    return generation;
}

int Coordinator::completeReplacement(const QString &sessionId, const QString &agentId,
                                    const QString &newSessionId, const QString &newAgentId)
{
    if (deletionBlocks(newSessionId) || deletionBlocksAgent(newAgentId))
        throw ChannelError(QStringLiteral("Session deletion is in progress"));
    const int generation =
        m_bindings.completeReplacement(sessionId, agentId, newSessionId, newAgentId);
    clearPendingUi(newSessionId);
    return generation;
}

void Coordinator::clearPendingUi(const QString &sessionId)
{
    if (sessionId.isEmpty()) return;
    const QString prefix = sessionId + QLatin1Char('\0');
    for (auto iterator = m_pendingUi.begin(); iterator != m_pendingUi.end();) {
        if (iterator.key().startsWith(prefix)) {
            iterator = m_pendingUi.erase(iterator);
        } else {
            ++iterator;
        }
    }
}

QJsonArray Coordinator::pendingUiRequests(const QString &sessionId) const
{
    QJsonArray items;
    const QString prefix = sessionId + QLatin1Char('\0');
    for (auto iterator = m_pendingUi.constBegin(); iterator != m_pendingUi.constEnd(); ++iterator) {
        if (!iterator.key().startsWith(prefix)) continue;
        const AgentSession::PendingUi &pending = iterator.value();
        QJsonObject item{
            {QStringLiteral("sessionId"), sessionId},
            {QStringLiteral("requestId"), pending.requestId},
            {QStringLiteral("method"), pending.method},
            {QStringLiteral("title"), pending.title},
            {QStringLiteral("allowOther"), pending.allowOther},
        };
        if (!pending.options.isEmpty()) {
            QJsonArray options;
            for (const QString &option : pending.options) options.append(option);
            item.insert(QStringLiteral("options"), options);
        }
        if (!pending.placeholder.isEmpty()) item.insert(QStringLiteral("placeholder"), pending.placeholder);
        if (!pending.prefill.isEmpty()) item.insert(QStringLiteral("prefill"), pending.prefill);
        if (!pending.batchQuestions.isEmpty()) {
            item.insert(QStringLiteral("batchQuestions"), pending.batchQuestions);
            if (pending.batchReview) item.insert(QStringLiteral("batchReview"), true);
        }
        items.append(item);
    }
    return items;
}

} // namespace runtime
