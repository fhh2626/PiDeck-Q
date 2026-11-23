#pragma once

#include "AgentTranscript.h"
#include "PiLaunch.h"
#include "RuntimeTypes.h"
#include "SubagentRuns.h"
#include "AgentMetrics.h"
#include "LiveChannels.h"
#include "ToolCallBatch.h"

#include "../MainCopy.h"

#include <QJsonObject>
#include <QJsonArray>
#include <QObject>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>
#include <QSet>

#include <functional>

class ChildProcessRegistry;
class PiEventClient;
class QTimer;

namespace agentruntime {

using runtime::Tab;

/** One renderer channel emission for this agent. */
struct Emit {
    std::function<void(const QString &channel, const QJsonValue &payload)> send;
};

/**
 * One pi process plus its renderer-visible tab state.
 *
 * Ownership: the process is created here, tracked by ChildProcessRegistry for bounded
 * shutdown, and never shared between sessions. Everything the renderer can observe
 * (status, sessionPath, streaming/tool flags, compaction count) lives on `tab()` so a
 * single `agents:state` snapshot is always self-consistent.
 *
 * The class deliberately exposes a raw `request()`: pi's RPC vocabulary is the
 * contract, and inventing wrapper commands per channel would drift from it.
 */
class AgentSession {
public:
    using ResponseHandler = std::function<void(bool ok, const QJsonObject &response, const QString &error)>;

    struct Options {
        QString agentId;
        QString projectId;
        QString cwd;
        QString title;
        QString deckSessionId;
        QString sessionPath;
        QString sessionEnvironment;
        QString sessionSource;
        bool isInternalSubagent = false;
        QString wslDistro;
        QString wslUser;
        QString importedSourceId;
        bool noSession = false;
        pilaunch::Launch launch;
        maincopy::Translator translate;
    };

    explicit AgentSession(Options options);
    ~AgentSession();

    /** Spawn pi. Returns false with `error` when the process could not start. */
    bool spawn(QString *error);
    /**
     * Replace the pi transport with a fresh process for the same session.
     *
     * Port of `AgentManager.reattachProcess`: the agentId, tab identity and transcript
     * survive, only the stdio client is new. The previous client is detached first (its
     * exit handler, event sink and pending RPCs are cleared/failed) so a late frame from
     * the dead process can never settle a request issued to its replacement.
     */
    bool reattach(const pilaunch::Launch &launch, QString *error);
    /** Monotonic transport identity; changes on every spawn/reattach. */
    quint64 clientEpoch() const { return m_clientEpoch; }
    /** Resolved implementation of the current transport, refreshed on every reattach. */
    QString runtimeKind() const { return m_options.launch.runtimeKind; }
    /** Pi's RPC model registry is a startup snapshot; a transport replacement refreshes it. */
    void invalidateModelConfiguration(const QJsonArray &models, const QJsonArray &providers,
                                      const QJsonArray &removed, const QJsonArray &available);
    bool hasStaleModelConfiguration(const QString &provider, const QString &modelId) const;
    bool wasModelRemoved(const QString &provider, const QString &modelId) const;
    /** Last actual model reported by get_state, used when the catalog has no explicit preference. */
    void observeModel(const QJsonObject &model) { m_observedModel = model; }
    QJsonObject observedModel() const { return m_observedModel; }
    /** Close stdin and let pi exit; the exit handler escalates to kill on a timer. */
    void close();
    void kill();
    bool running() const;

    /** OS process id of the pi child, or 0 when it is not running. */
    qint64 processId() const;

    Tab &tab() { return m_tab; }
    const Tab &tab() const { return m_tab; }
    Transcript &transcript() { return m_transcript; }
    const Transcript &transcript() const { return m_transcript; }
    maincopy::Translator translate() const { return m_translate; }

    void setEmit(Emit sink) { m_emit = std::move(sink); }
    void setExitHandler(std::function<void(int, const QString &)> handler)
    {
        m_exitHandler = std::move(handler);
    }
    void setChildRegistry(ChildProcessRegistry *registry) { m_children = registry; }

    /**
     * Unsolicited pi events. AgentEvents.h depends on this header, so the sink is a
     * plain callable instead of EventHooks to keep the include graph acyclic.
     */
    void setEventSink(std::function<void(const QJsonObject &)> sink) { m_onEvent = std::move(sink); }
    /** Raw pi stderr lines; the coordinator forwards them as the log channel. */
    void setStderrSink(std::function<void(const QString &)> sink) { m_onStderr = std::move(sink); }
    /**
     * One pi RPC frame per direction (`send`/`recv`) for the RPC log panel.
     *
     * The coordinator owns the user-controlled recording gate and the batching, so the
     * session only forwards what the pipe carried.
     */
    void setRpcLogSink(std::function<void(const QString &, const QJsonObject &)> sink)
    {
        m_onRpcLog = std::move(sink);
    }

    /** Send one pi RPC command; the handler runs exactly once on the event loop. */
    void request(const QString &type, const QJsonObject &fields, int timeoutMs, ResponseHandler done);
    void request(const QJsonObject &command, int timeoutMs, ResponseHandler done);

    /** Write a pi notification (`extension_ui_response`) without awaiting an answer. */
    void notify(const QJsonObject &command);

    void emitChannel(const QString &channel, const QJsonValue &payload) const;
    /** `agents:state` payload is the whole tab list, so the coordinator builds it. */
    void emitState() const;

    QString stderrTail() const;

    /**
     * QObject used as the lifetime context for timers bound to this session.
     *
     * Deliberately *not* the current client's QProcess: a reattach replaces the process
     * while the tab keeps living, so session-scoped timers (ask timeout, abort-settled
     * fallback, close grace) must outlive one transport and die with the session.
     */
    QObject *timerContext() const;

    /** Session file `mtime:size` used as the renderer's index version. */
    QString fileVersion() const;
    void refreshFileVersion();

    void setStatus(const QString &status);
    void markError(const QString &kind);

    /** Pending interactive UI requests keyed by requestId (session-scoped). */
    struct PendingUi {
        QString requestId;
        QString method;
        QString title;
        QStringList options;
        QString placeholder;
        QString prefill;
        bool allowOther = false;
        QJsonArray batchQuestions;
        bool batchReview = false;
    };
    QHash<QString, PendingUi> &pendingUi() { return m_pendingUi; }
    const QHash<QString, PendingUi> &pendingUi() const { return m_pendingUi; }

    /** Subagent live-run projection keyed by child session file (sidebar dots). */
    SubagentRuns &subagentRuns() { return m_subagentRuns; }
    const SubagentRuns &subagentRuns() const { return m_subagentRuns; }

    /**
     * Open parallel tool calls (oracle `activeToolCallsByAgent`).
     *
     * Session-scoped rather than per-event because the `isExecutingTool` edge is only
     * correct across the whole batch: the first `tool_execution_end` of two overlapping
     * calls must not publish `false`. Cleared by `agent_start`, a settle and an abort.
     */
    toolbatch::Calls &activeToolCalls() { return m_activeToolCalls; }
    const toolbatch::Calls &activeToolCalls() const { return m_activeToolCalls; }

    /**
     * Live thinking/text/message coalescers (50 ms windows).
     *
     * Once per session so a reattach keeps the delivery window and destroying the
     * session cancels every pending frame in the same module.
     */
    LiveChannels &liveChannels() { return m_live; }
    /** Last-reply TTFT / total / TPS metrics (`AgentManager.lastPerfByAgent`). */
    agentmetrics::ReplyPerfTracker &perf() { return m_perf; }
    const agentmetrics::ReplyPerfTracker &perf() const { return m_perf; }

    /**
     * (Re)arm the subagent expiry timer from the projection's earliest deadline.
     *
     * Port of `SubagentExpiryScheduler.schedule`: one timer per runtime, armed only for an
     * *earlier* deadline. A heartbeat extends the data deadline, not the timer; when the
     * armed timer fires it rechecks the refreshed deadline and re-arms once instead of
     * churning a timer per event.
     */
    void armSubagentExpiry();

    /** Ask-aborted marker: a cancelled ask must render as cancelled, not answered. */
    bool askAborted() const { return m_askAborted; }
    void setAskAborted(bool aborted) { m_askAborted = aborted; }

    /** True while a turn is running (agent_start .. agent_settled). */
    bool turnActive() const { return m_turnActive; }
    void setTurnActive(bool active) { m_turnActive = active; }

    /**
     * Streaming gate (port of `src/main/pi/streamGate.ts`).
     *
     * `streamSealed()` is true after an abort until the abort's own `agent_settled` has
     * been seen; late deltas from the stopped run are dropped instead of reviving the
     * bubble. A run that starts *before* that settled only records `pendingOpen`, so the
     * generation advances after the settled — the LAN stream uses the same generation to
     * tell the two runs apart.
     */
    bool streamSealed() const
    {
        return m_sealedGeneration >= 0 && m_runGeneration <= m_sealedGeneration;
    }
    /** Abort: seal the current generation and wait for its settled event. */
    void sealStream();
    /** `agent_start`: a new run. While an abort is unanswered only record the intent. */
    void openStream();
    /** `agent_settled`: end the abort wait, opening the pending run if one started. */
    void noteAbortSettled();
    /** True between an abort and its settled event (stream gate is waiting). */
    bool waitingForAbortSettled() const { return m_waitingForAbortSettled; }
    /** True when a new run started before the abort's settled (late-settled case). */
    bool pendingOpenAfterSettled() const { return m_pendingOpenAfterSettled; }
    /** Monotonic run identity; a new value means "a different agent run". */
    int runGeneration() const { return m_runGeneration; }
    /** Invalidates idle probes before command lookup and again at actual prompt dispatch. */
    quint64 advancePromptDispatchSequence() { return ++m_promptDispatchSequence; }
    quint64 promptDispatchSequence() const { return m_promptDispatchSequence; }

    bool recentlyAborted() const { return m_recentlyAborted; }
    void setRecentlyAborted(bool aborted) { m_recentlyAborted = aborted; }

    /** Set when a manual compact is in flight so compaction_end does not reload twice. */
    bool manualCompaction() const { return m_manualCompaction; }
    void setManualCompaction(bool value) { m_manualCompaction = value; }
    /**
     * pi reported `compaction_start` while the manual compact RPC was in flight.
     *
     * `finishManualCompaction` must not claim idle until the matching end event lands
     * (oracle `manualCompactionEventAgents`).
     */
    bool manualCompactionEvent() const { return m_manualCompactionEvent; }
    void setManualCompactionEvent(bool value) { m_manualCompactionEvent = value; }
    /**
     * A new run started during the manual compact (queued follow-up).
     *
     * Oracle `manualCompactionFollowUpAgents`: the compact's completion must not push a
     * run that pi already started back to idle.
     */
    bool manualCompactionFollowUp() const { return m_manualCompactionFollowUp; }
    void setManualCompactionFollowUp(bool value) { m_manualCompactionFollowUp = value; }
    /**
     * The explicit post-compact reload owns the history refresh.
     *
     * Oracle `manualCompactionReloadClaims`: a `compaction_end` that arrives while the RPC
     * reload is running must not reload again (a short snapshot would overwrite the answer
     * the user just read).
     */
    void claimManualCompactionReload();
    bool consumeManualCompactionReloadClaim();
    /**
     * A clean-exit reconnect is already in flight for this runtime.
     *
     * Oracle `autoRestartAttemptedAgents`: a pi that exits with code 0 while owning a
     * session file is usually restarting itself (auto-compaction / model refresh), so the
     * desktop reconnects once instead of dropping the runtime. The flag is cleared again
     * after a successful reconnect so the next clean exit may reconnect too.
     */
    bool autoRestartAttempted() const { return m_autoRestartAttempted; }
    void setAutoRestartAttempted(bool attempted) { m_autoRestartAttempted = attempted; }
    /** Entry id source: "rpc" once get_entries succeeded, "file" when unsupported. */
    QString entrySource() const { return m_entrySource; }
    void setEntrySource(const QString &source) { m_entrySource = source; }

    QStringList activeEntryIds() const { return m_activeEntryIds; }
    void setActiveEntryIds(const QStringList &ids) { m_activeEntryIds = ids; }

    int messageLoadSequence() const { return m_messageLoadSequence; }
    int beginMessageLoad() { return ++m_messageLoadSequence; }

private:
    void failPending(const QString &reason);
    /**
     * Drop the current transport without touching tab identity.
     *
     * Clears every callback before closing so the dead process's queued lines and its
     * `finished` signal cannot reach the session that already moved on.
     */
    void detachClient(const QString &reason);
    /** Delete transports retired in an earlier event-loop turn (never inside a signal). */
    void reapRetiredClients();
    /** Timer callback: drop TTL-expired subagent rows and publish the new projection. */
    void expireSubagents();

    Options m_options;
    Tab m_tab;
    maincopy::Translator m_translate;
    Transcript m_transcript;
    PiEventClient *m_client = nullptr;
    ChildProcessRegistry *m_children = nullptr;
    Emit m_emit;
    std::function<void(int, const QString &)> m_exitHandler;
    std::function<void(const QJsonObject &)> m_onEvent;
    std::function<void(const QString &)> m_onStderr;
    std::function<void(const QString &, const QJsonObject &)> m_onRpcLog;
    QHash<QString, PendingUi> m_pendingUi;
    SubagentRuns m_subagentRuns;
    toolbatch::Calls m_activeToolCalls;
    agentmetrics::ReplyPerfTracker m_perf;
    /** Single-shot subagent TTL timer, child of `m_timerContext` (dies with the session). */
    QTimer *m_subagentExpiry = nullptr;
    /** Absolute ms of the armed deadline; 0 when the timer is disarmed. */
    qint64 m_subagentExpiryDeadline = 0;
    QStringList m_activeEntryIds;
    QString m_entrySource;
    QString m_fileVersion;
    int m_messageLoadSequence = 0;
    bool m_turnActive = false;
    int m_runGeneration = 0;
    quint64 m_promptDispatchSequence = 0;
    /** Generation sealed by the last abort; `-1` when the gate is open. */
    int m_sealedGeneration = -1;
    bool m_waitingForAbortSettled = false;
    bool m_pendingOpenAfterSettled = false;
    /** Identifies the current abort wait so a stale fallback timer cannot open it. */
    quint64 m_gateToken = 0;
    /** Transport identity starts at 1; zero is reserved for recovery without an owned transport. */
    quint64 m_clientEpoch = 1;
    quint64 m_modelConfigurationEpoch = 0;
    QSet<QString> m_staleModels;
    QSet<QString> m_staleModelProviders;
    QSet<QString> m_removedModels;
    QJsonObject m_observedModel;
    /** Stable QObject for session-scoped timers; survives a process reattach. */
    mutable QObject m_timerContext;
    /**
     * Coalesced live channels.
     *
     * Declared after `m_timerContext` on purpose: its constructor attaches the timers to
     * that context, so the context must already be constructed.
     */
    LiveChannels m_live{this};
    /** Closed transports waiting for their deferred delete. */
    QVector<PiEventClient *> m_retired;
    bool m_recentlyAborted = false;
    bool m_autoRestartAttempted = false;
    bool m_manualCompaction = false;
    bool m_manualCompactionEvent = false;
    bool m_manualCompactionFollowUp = false;
    bool m_manualCompactionReloadClaim = false;
    bool m_askAborted = false;
    bool m_closing = false;
};

} // namespace agentruntime
