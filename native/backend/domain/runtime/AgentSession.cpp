#include "AgentSession.h"

#include "ChildProcessRegistry.h"
#include "PiEventClient.h"

#include <QDateTime>
#include <QFileInfo>
#include <QTimer>

namespace agentruntime {
namespace {

qint64 nowMs()
{
    return QDateTime::currentMSecsSinceEpoch();
}

/** Bounded stdin-close grace before the process is killed. */
constexpr int kCloseGraceMs = 2'000;

/**
 * Abort-settled fallback (oracle `ABORT_SETTLED_FALLBACK_MS`).
 *
 * Some runtimes (Pi_Agent_Rust) never emit `agent_settled`; without this bound the gate
 * would stay sealed forever and the user's next turn would never stream again.
 */
constexpr int kAbortSettledFallbackMs = 1'500;

} // namespace

AgentSession::AgentSession(Options options)
    : m_options(std::move(options)), m_translate(m_options.translate),
      m_subagentRuns(SubagentRuns::limitsFromEnvironment())
{
    m_tab.id = m_options.agentId;
    m_tab.projectId = m_options.projectId;
    m_tab.cwd = m_options.cwd;
    m_tab.title = m_options.title;
    m_tab.status = QStringLiteral("starting");
    m_tab.deckSessionId = m_options.deckSessionId;
    m_tab.sessionPath = m_options.sessionPath;
    m_tab.sessionEnvironment = m_options.sessionEnvironment;
    m_tab.sessionSource = m_options.sessionSource;
    m_tab.isInternalSubagent = m_options.isInternalSubagent;
    m_tab.wslDistro = m_options.wslDistro;
    m_tab.wslUser = m_options.wslUser;
    m_tab.importedSourceId = m_options.importedSourceId;
    m_tab.noSession = m_options.noSession;
    m_tab.createdAt = nowMs();
    m_transcript.configure(m_tab.id, m_translate);
    refreshFileVersion();
    // One single-shot timer for the subagent TTLs, owned by the session so a reattach keeps
    // it and destruction (or close) pairs the cancel with the runtime it belongs to.
    m_subagentExpiry = new QTimer(&m_timerContext);
    m_subagentExpiry->setSingleShot(true);
    // One deadline per runtime and no polling: a precise timer keeps the TTL honest
    // instead of inheriting the coarse timer's early-firing slack.
    m_subagentExpiry->setTimerType(Qt::PreciseTimer);
    QObject::connect(m_subagentExpiry, &QTimer::timeout, &m_timerContext,
                     [this]() { expireSubagents(); });
    m_subagentRuns.setScheduleHook([this]() { armSubagentExpiry(); });
}

AgentSession::~AgentSession()
{
    if (m_subagentExpiry) {
        m_subagentExpiry->stop();
        m_subagentExpiryDeadline = 0;
    }
    if (m_client) {
        m_client->setExitHandler({});
        m_client->close(QStringLiteral("agent session destroyed"));
        delete m_client;
        m_client = nullptr;
    }
    // A transport retired in this same turn may still have a posted reap pending; the
    // session owns the memory, so drain it here instead of leaking.
    reapRetiredClients();
}

bool AgentSession::spawn(QString *error)
{
    detachClient(QStringLiteral("agent session restarted"));
    m_closing = false;
    auto *client = new PiEventClient();
    m_client = client;
    // Correlated responses settle their own promise; every other line is an agent
    // event (message/tool/ask/notice) and must reach the projector, never be dropped.
    client->setEventHandler([this](const QJsonObject &event) {
        if (m_onEvent) m_onEvent(event);
    });
    client->setStderrHandler([this](const QString &text) {
        if (m_onStderr) m_onStderr(text);
    });
    client->setLogHandler([this](const QString &direction, const QJsonObject &data) {
        // Copy before invoking: the sink may stop/dispose this session, which would
        // otherwise destroy the callable mid-flight (same hazard as the event handler).
        if (!m_onRpcLog) return;
        const auto sink = m_onRpcLog;
        sink(direction, data);
    });
    client->setExitHandler([this](int code, QProcess::ExitStatus status) {
        m_tab.status = QStringLiteral("closed");
        m_tab.isStreaming = false;
        m_tab.isExecutingTool = false;
        m_tab.executingToolName.clear();
        m_transcript.clearActiveAssistant();
        // The process is gone: no pending coalesced frame may be published for it (a
        // late timer would otherwise revive a live bubble on a closed runtime).
        m_live.reset();
        m_perf.resetOpen();
        const QString reason = status == QProcess::CrashExit
            ? QStringLiteral("pi process crashed")
            : QStringLiteral("pi exited with code %1").arg(code);
        if (m_exitHandler) {
            const auto handler = m_exitHandler;
            handler(code, reason);
        }
    });
    if (!client->start(m_options.launch.program, m_options.launch.arguments, m_options.launch.cwd,
                       m_options.launch.environment, m_options.launch.nativeArguments)) {
        if (error) {
            const QString stderrTail = client->stderrTail().trimmed();
            *error = stderrTail.isEmpty()
                ? QStringLiteral("pi process failed to start")
                : QStringLiteral("pi process failed to start: %1").arg(stderrTail);
        }
        return false;
    }
    // Track the child so shutdown can stop it inside the host's force-kill budget.
    if (m_children) m_children->track(client->process(), QStringLiteral("pi"));
    return true;
}

void AgentSession::detachClient(const QString &reason)
{
    if (!m_client) return;
    ++m_clientEpoch;
    PiEventClient *client = m_client;
    m_client = nullptr;
    // Clear every callback first: the process may still have a queued line or its
    // `finished` signal pending, and neither may reach a session that already moved on
    // to a replacement process (that is the whole point of the fence).
    client->setExitHandler({});
    client->setEventHandler({});
    client->setStderrHandler({});
    client->setLogHandler({});
    // Fails this transport's pending RPCs exactly once with `reason`; a late reply whose
    // id is no longer pending is dropped instead of replayed as an agent event.
    client->close(reason);
    // `PiEventClient` is not a QObject (it owns one), so it cannot deleteLater() itself.
    // Retire it and delete on the next event-loop turn: this call chain starts inside the
    // old process's own `readyRead`, and deleting a sender there is not safe.
    m_retired.append(client);
    QMetaObject::invokeMethod(&m_timerContext, [this]() { reapRetiredClients(); },
                              Qt::QueuedConnection);
}

void AgentSession::reapRetiredClients()
{
    const QVector<PiEventClient *> retired = m_retired;
    m_retired.clear();
    for (PiEventClient *client : retired) delete client;
}

bool AgentSession::reattach(const pilaunch::Launch &launch, QString *error)
{
    detachClient(QStringLiteral("pi process reattached"));
    m_options.launch = launch;
    // The tab survives the transport swap, so clear only the gates a dead process can no
    // longer resolve. `runtimeGeneration` and `agentId` stay: the renderer's target is
    // still valid, which is exactly what the oracle's reattach guarantees.
    m_closing = false;
    m_turnActive = false;
    m_recentlyAborted = false;
    m_askAborted = false;
    m_tab.isStreaming = false;
    m_tab.isExecutingTool = false;
    m_tab.executingToolName.clear();
    transcript().clearActiveAssistant();
    // Any projection load still in flight belongs to the dead process.
    beginMessageLoad();
    return spawn(error);
}

void AgentSession::claimManualCompactionReload()
{
    // Idempotent like the oracle set: claiming twice is still one owned reload.
    m_manualCompactionReloadClaim = true;
}

bool AgentSession::consumeManualCompactionReloadClaim()
{
    const bool claimed = m_manualCompactionReloadClaim;
    m_manualCompactionReloadClaim = false;
    return claimed;
}

void AgentSession::close()
{
    // A runtime being stopped owns its subagent cleanup: cancel the TTL timer so a later
    // fire cannot publish rows for a disposed agent (oracle `clearAgent` cancels it).
    if (m_subagentExpiry) {
        m_subagentExpiry->stop();
        m_subagentExpiryDeadline = 0;
    }
    if (!m_client || m_closing) return;
    m_closing = true;
    // Drop pending live frames on stop: the oracle cancels the coalescers in
    // `clearAgent`/abort, so a stopped runtime cannot repaint a bubble after the detach
    // frame.
    m_live.reset();
    m_perf.resetOpen();
    m_client->requestClose();
    // pi normally exits as soon as stdin closes; a hung process must not keep the
    // runtime alive forever, so escalate on a bounded timer. The epoch check keeps a
    // timer fired after a reattach from killing the *replacement* process.
    const quint64 epoch = m_clientEpoch;
    QTimer::singleShot(kCloseGraceMs, timerContext(), [this, epoch]() {
        if (epoch != m_clientEpoch) return;
        if (m_client && m_client->running()) m_client->terminateNow();
    });
}

void AgentSession::kill()
{
    if (!m_client) return;
    m_client->terminateNow();
}

bool AgentSession::running() const
{
    return m_client && m_client->running();
}

qint64 AgentSession::processId() const
{
    if (!m_client || !m_client->running()) return 0;
    return qint64(m_client->process()->processId());
}

void AgentSession::request(const QString &type, const QJsonObject &fields, int timeoutMs,
                           ResponseHandler done)
{
    QJsonObject command = fields;
    command.insert(QStringLiteral("type"), type);
    request(command, timeoutMs, std::move(done));
}

void AgentSession::request(const QJsonObject &command, int timeoutMs, ResponseHandler done)
{
    if (!m_client || !m_client->running()) {
        if (done) done(false, QJsonObject{}, QStringLiteral("pi is not running"));
        return;
    }
    m_client->request(command, timeoutMs, std::move(done));
}

void AgentSession::notify(const QJsonObject &command)
{
    if (!m_client || !m_client->running()) return;
    m_client->sendRaw(command);
}

void AgentSession::emitChannel(const QString &channel, const QJsonValue &payload) const
{
    if (m_emit.send) m_emit.send(channel, payload);
}

void AgentSession::emitState() const
{
    // The tab list is assembled by the coordinator; this hook only marks the intent.
    if (m_emit.send) m_emit.send(QStringLiteral("agents:state"), QJsonValue());
}

QString AgentSession::stderrTail() const
{
    return m_client ? m_client->stderrTail() : QString();
}

QObject *AgentSession::timerContext() const
{
    return &m_timerContext;
}

void AgentSession::armSubagentExpiry()
{
    if (!m_subagentExpiry) return;
    const qint64 deadline = m_subagentRuns.nextExpiryDeadline();
    if (deadline <= 0) {
        m_subagentExpiry->stop();
        m_subagentExpiryDeadline = 0;
        return;
    }
    // An armed earlier timer rechecks the (possibly refreshed) deadline when it fires, so
    // a heartbeat must not re-arm the timer on every frame.
    if (m_subagentExpiry->isActive() && m_subagentExpiryDeadline <= deadline) return;
    m_subagentExpiryDeadline = deadline;
    // Floor at 1 ms: a deadline that already passed was pruned by the caller, and a 0 ms
    // timer would spin the event loop until the clock catches up.
    constexpr qint64 kMaxArmDelayMs = qint64(24) * 60 * 60 * 1000;
    const qint64 delay = qBound<qint64>(qint64(1), deadline - nowMs(), kMaxArmDelayMs);
    m_subagentExpiry->start(int(delay));
}

void AgentSession::expireSubagents()
{
    m_subagentExpiryDeadline = 0;
    const qint64 now = nowMs();
    if (m_subagentRuns.expire(now)) {
        // Same frame `emitSubagentStatus` publishes: the renderer sanitizer accepts only
        // `sessionFile` + `running|error`, and an empty array clears the sidebar dots.
        emitChannel(QStringLiteral("agents:subagent-status"), QJsonObject{
            {QStringLiteral("agentId"), m_tab.id},
            {QStringLiteral("runs"), m_subagentRuns.snapshot(now)},
        });
    }
    armSubagentExpiry();
}

void AgentSession::sealStream()
{
    m_sealedGeneration = m_runGeneration;
    m_waitingForAbortSettled = true;
    // A newer abort overrides an older pending start (never unseal for the wrong run).
    m_pendingOpenAfterSettled = false;
    ++m_gateToken;
}

void AgentSession::openStream()
{
    if (m_waitingForAbortSettled) {
        m_pendingOpenAfterSettled = true;
        QObject *context = timerContext();
        if (!context) {
            noteAbortSettled();
            return;
        }
        const quint64 token = m_gateToken;
        // A stale timer must never open a later abort's gate: the token changes on every
        // seal/settle, and the waiting flag is re-checked when it fires.
        QTimer::singleShot(kAbortSettledFallbackMs, context, [this, token] {
            if (m_gateToken != token || !m_waitingForAbortSettled) return;
            noteAbortSettled();
        });
        return;
    }
    ++m_runGeneration;
    m_sealedGeneration = -1;
    m_pendingOpenAfterSettled = false;
    ++m_gateToken;
}

void AgentSession::noteAbortSettled()
{
    if (!m_waitingForAbortSettled) return;
    m_waitingForAbortSettled = false;
    const bool openPending = m_pendingOpenAfterSettled;
    m_pendingOpenAfterSettled = false;
    ++m_gateToken;
    if (!openPending) return;
    ++m_runGeneration;
    m_sealedGeneration = -1;
}

QString AgentSession::fileVersion() const
{
    return m_fileVersion;
}

void AgentSession::refreshFileVersion()
{
    if (m_tab.sessionPath.isEmpty()) {
        m_fileVersion.clear();
        return;
    }
    const QFileInfo info(m_tab.sessionPath);
    if (!info.exists()) {
        m_fileVersion.clear();
        return;
    }
    m_fileVersion = QStringLiteral("%1:%2")
                        .arg(info.lastModified().toMSecsSinceEpoch())
                        .arg(info.size());
}

void AgentSession::setStatus(const QString &status)
{
    if (m_tab.status == status) return;
    m_tab.status = status;
    emitState();
}

void AgentSession::markError(const QString &kind)
{
    m_tab.errorKind = kind;
    m_tab.status = QStringLiteral("error");
    emitState();
}

} // namespace agentruntime
