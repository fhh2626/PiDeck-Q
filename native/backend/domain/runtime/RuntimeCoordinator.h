#pragma once

#include "AgentEvents.h"
#include "AgentSession.h"
#include "RuntimeBindings.h"
#include "RuntimeTypes.h"

#include "../ChannelContext.h"
#include "../sessions/CatalogTypes.h"
#include "../sessions/HistoryPager.h"
#include "../sessions/SessionTreeGuard.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QSet>
#include <QString>

#include <functional>
#include <map>
#include <memory>

namespace modellist {
struct ThinkingSupport;
}

/**
 * Multi-session pi runtime owner.
 *
 * Port of src/main/sessions/SessionRuntimeCoordinator.ts. One instance owns every pi
 * process the backend spawns for sessions, the session<->agent binding table, the
 * generation counter, dispatch leases, the idempotent prompt-delivery cache and the
 * pending interactive UI requests.
 *
 * Ownership rules:
 *  - a session has at most one runtime; activation is serialized per session;
 *  - a command carries `sessionId + agentId + runtimeGeneration` and is rejected when
 *    the binding moved (`SESSION_RUNTIME_CHANGED`);
 *  - a late reply from a replaced process is discarded, never attributed to the new one;
 *  - every renderer-visible payload is wrapped in the `sessions:runtime-event` envelope
 *    (`{kind, sessionId, agentId, runtimeGeneration, sourceChannel, payload}`).
 */
namespace runtime {

using agentruntime::AgentSession;
using agentruntime::EventHooks;

class Coordinator {
public:
    struct Deps {
        ChannelServices *services = nullptr;
        /** Lazy settings read so a settings change applies to the next spawn. */
        std::function<QJsonObject()> settings;
        QString agentDir;
        QString resourcesDir;
        QString userDataDir;
        /**
         * Resolved UI locale for the pi child (`PIDECK_UI_LANGUAGE`).
         *
         * Lazy on purpose: the oracle's `getLocale` closure reads the current settings
         * on every spawn, so a language change applies to the next runtime without a
         * backend restart. The value must be the resolved BCP-47 tag, never the raw
         * `system`/`pseudo` settings value.
         */
        std::function<QString()> uiLocale;
        QString securitySnapshotPath;
        /**
         * Interactive project-trust prompt.
         *
         * `resolveTrustOverride` fails closed ("no-approve") when a project carries
         * trust-requiring resources and no decision is recorded. The projects domain owns
         * the prompt, so the coordinator asks through this hook and waits for the answer
         * instead of silently refusing to load the user's own extensions.
         */
        std::function<void(const QString &cwd, const QString &projectName,
                           std::function<void(const QString &choice)> done)> requestTrust;
        /** Record a "trust and remember" decision for a project directory. */
        std::function<void(const QString &cwd)> rememberTrust;
        /** Forward a `projects:trust-response` to the pending prompt owner. */
        std::function<void(const QString &requestId, const QString &choice)> respondTrust;
        /**
         * Completion toast for a normally finished turn (`AgentManager.notifySessionEnd`).
         *
         * Only the runtime knows whether a settled event was a real completion, so the
         * coordinator makes that decision and the notification owner applies the user
         * setting / platform gate. No callback means no toast (tests, headless runs).
         */
        std::function<void(const QString &agentId, const QString &sessionTitle,
                           const QString &sessionId)> notifySessionSettled;

        /**
         * Desktop reminder for an ask raised by a session the user is not looking at
         * (`AgentManager.notifyAskPending`).
         *
         * The toast body is built by the notification owner (it applies the user setting,
         * the platform gate and the per-run dedupe); the runtime only decides *whether*
         * the asking session is unfocused and which title/question to show.
         */
        std::function<void(const QString &agentId, const QString &sessionTitle,
                           const QString &question, const QString &sessionId)> notifyAskPending;
        /** `agent_start`: re-arm the ask reminder for the agent's new run. */
        std::function<void(const QString &agentId)> noteRunStarted;

        /**
         * One pi RPC frame for the user-gated debug panel (`agents:rpc-log`).
         *
         * The sink owns the recording gate, the summary and the ~80 ms batching, so the
         * runtime never decides whether a frame is interesting enough to publish.
         */
        std::function<void(const QString &agentId, const QString &direction,
                           const QJsonObject &data)> recordRpcLog;
        /**
         * Runtime disposed (`AgentManager.clearAgentState`): forget its recording gate
         * and drop its queued live batches. A fresh agentId can never inherit them.
         */
        std::function<void(const QString &agentId)> disposeRpcLog;
        /**
         * Defer one task to the next event-loop turn.
         *
         * A process exit fails the in-flight RPCs *before* the exit handler runs, so a
         * command that has to react to both (compaction reattach) must not act inside the
         * RPC callback. The application object owns the event loop, so it provides the
         * posting primitive instead of the runtime inventing a timer.
         */
        std::function<void(std::function<void()>)> post;
    };

    explicit Coordinator(Deps deps);
    ~Coordinator();

    /** Stop every agent and reject pending work. Idempotent. */
    void shutdown();

    // ── session ownership ────────────────────────────────────────────────
    bool isSessionBusy(const QString &sessionId) const;
    /** True when the session or any child session in its tree owns a live runtime. */
    bool isSessionTreeBusy(const QString &sessionId) const;
    /**
     * First reason the session's tree cannot be deleted/archived/renamed.
     *
     * Port of `findSessionTreeBlock` (sessionTreeGuard.ts): the root, any catalog session
     * whose file sits below `<stem>/` (fork/subagent children, not only records carrying
     * `parentSessionPath`), and any live agent still appending inside that directory.
     * Returns `{}` when idle, otherwise `{kind:"session-busy",sessionId}` or
     * `{kind:"file-in-use",agentTitle}`.
     */
    QJsonObject findSessionTreeBlock(const QString &sessionId) const;
    /** Live runtime agents as tree-guard inputs (title + host session path + environment). */
    QVector<sessiontreeguard::LiveAgent> liveTreeAgents() const;
    /**
     * Runtime-cache-first turn page (`AgentManager.tryReadRuntimeTurnPage`).
     *
     * `before`/`nextBefore` stay in the *file* index space: the returned page's rows are
     * sliced from the live transcript, but both cursors are resolved through the JSONL
     * index, so the renderer's continuation protocol does not change. Returns false when
     * the cache cannot answer (no runtime, different session path, anchor absent, or the
     * cursor would land at the cache's first row) and the caller must read the file.
     */
    bool tryReadRuntimeTurnPage(const QString &sessionId, const QString &filePath,
                                const QString &beforeEntryId, bool hasBefore, int before,
                                int turnCount, historypager::Page *page);
    /** Live runtime session path for history reads (empty when not bound). */
    QString runtimeSessionPath(const QString &sessionId) const;
    QString runtimeAgentId(const QString &sessionId) const;
    /**
     * Untruncated tool result text from the live transcript (oracle
     * `AgentManager.readMessageFullText` cache hit). Empty when the row never carried a
     * truncated detail, so the caller must read the session file instead.
     */
    QString liveToolFullText(const QString &sessionId, const QString &messageId) const;
    /** Stable record id currently bound to an agent (empty when the agent is gone). */
    QString sessionIdForAgent(const QString &agentId) const;
    /** Validate a renderer-supplied session/agent/generation triple. */
    bool validateTarget(const QJsonObject &target, QString *error) const;
    /** Working directory of a live agent runtime (empty when it is gone). */
    QString agentCwd(const QString &agentId) const;
    /** Live pi processes as `[{agentId, pid, sessionId?, sessionTitle?}]`. */
    QJsonArray agentProcesses() const;
    /**
     * True while any bound agent is inside a streaming turn.
     *
     * The memory profiler needs the same "is the app busy" flag the Node oracle reads from
     * AgentManager, and it must not be derived from pi state polling: deltas set it, the
     * terminal events clear it. Runtime-only state, so no process round trip.
     */
    bool hasActiveStreaming() const;
    /** Stop one agent by id through the full session-stop path. */
    void stopAgent(const QString &agentId, std::function<void(QJsonObject)> done);
    void setFocusedSession(const QString &sessionId);    // ── owner-thread marshalling (RuntimeOwnerThread.cpp) ────────────
    /**
     * Run `task` on the Qt owner thread that owns every runtime object.
     *
     * `AgentSession`, `PiEventClient`, the underlying `QProcess`, the agent table and the
     * tree guard are all single-threaded state. Channel bodies that run on the serial
     * domain executor (catalog mutations, history reads) must therefore never touch them
     * directly; they hand the work over through here and continue in the callback. When
     * the caller is already on the owner thread the task runs inline (no reordering).
     */
    void postToOwner(std::function<void()> task);
    /** True when the caller runs on the Qt owner thread (see `postToOwner`). */
    bool onOwnerThread() const;

    /** Outcome of `renameRuntimeAsync`; `NoRuntime` is a routing answer, not a failure. */
    enum class RenameOutcome { NoRuntime, Renamed, Failed };
    /**
     * Rename a live session through pi and report the *real* outcome.
     *
     * Port of `AgentManager.rename` + `SessionRecordService.update`: the RPC is awaited
     * (20 s, the oracle's budget) and a refusal is reported as `Failed`, so the caller can
     * leave the catalog title untouched (`mainAgent.renameFailed`). The reply is fenced on
     * the agent binding: a runtime replaced by fork/clone while the RPC was in flight must
     * never have its successor renamed by the stale answer.
     */
    void renameRuntimeAsync(const QString &sessionId, const QString &name,
                            std::function<void(RenameOutcome, const QString &error)> done);
    /**
     * Tree-safety verdict resolved on the owner thread (`findSessionTreeBlock`).
     *
     * Archive/delete/rename-by-file run their filesystem planning on the executor, but the
     * verdict itself reads the live agent table, which only the owner thread may touch.
     */
    void sessionTreeBlockAsync(const QString &sessionId, std::function<void(const QJsonObject &)> done);

    /**
     * Re-push full renderer state after an event-stream gap.
     *
     * The renderer deliberately ignores `native.resyncRequired` object payloads (it must
     * not navigate on a transport hiccup), so a truncated SSE history is only repaired by
     * re-sending the tab table and every bound agent's whole message window. A page reload
     * is *not* a substitute: it would discard drafts and in-flight composer state.
     */
    void resyncLiveState();

    /**
     * Live transcript snapshot: `{target, value}` (`AgentManager.getSessionRuntimeMessages`).
     *
     * Empty object when the session owns no runtime. The web client renders the tail from
     * this and then patches it from the event stream, so the snapshot has to be the same
     * projected rows the desktop window shows — not a second projection.
     */
    QJsonObject runtimeMessages(const QString &sessionId) const;
    /** Sessions with an activation in flight (`isSessionActivating`), for `/api/state`. */
    QStringList activatingSessions() const;

    /** Answer a pending project-trust prompt (projects:trust-response). */
    void respondTrustRequest(const QString &requestId, const QString &choice);

    // ── observers (LAN web stream) ───────────────────────────────────────
    /**
     * Raw pi event subscriber, equivalent to `AgentManager.addLocalEventListener`.
     *
     * `streamGeneration` identifies the run the event belongs to: `agent_start` carries
     * the next generation while the gate is still at the old one, so a late settled from
     * an aborted run cannot finish the replacement. Returns a token for `removeObserver`.
     */
    using PiEventObserver =
        std::function<void(const QString &agentId, const QJsonObject &event, int streamGeneration)>;
    int addPiEventObserver(PiEventObserver observer);
    /** `agents:state` observer (`subscribeRuntimeChanges` for the runtime snapshot). */
    int addStateObserver(std::function<void()> observer);
    /** Remove either kind of observer; unknown tokens are ignored (idempotent). */
    void removeObserver(int token);

    // ── channels (wire JSON in/out) ──────────────────────────────────────
    QJsonValue listRuntimes() const;
    void activate(const QString &sessionId, std::function<void(QJsonObject)> done);
    void send(const QJsonObject &input, std::function<void(QJsonObject)> done);
    void stop(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void abort(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void flushMessages(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void restart(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void compact(const QJsonObject &target, const QString &prompt, std::function<void(QJsonObject)> done);
    void state(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void commands(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void models(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void exportHtml(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void editMessage(const QJsonObject &target, const QString &messageId, const QString &text,
                     std::function<void(QJsonObject)> done);
    void deleteMessage(const QJsonObject &target, const QString &messageId,
                       std::function<void(QJsonObject)> done);
    void prepareResend(const QJsonObject &target, const QString &messageId, const QJsonObject &model,
                       const QString &thinkingLevel, std::function<void(QJsonObject)> done);
    void setModel(const QJsonObject &target, const QString &provider, const QString &modelId,
                  std::function<void(QJsonObject)> done);
    void setThinking(const QJsonObject &target, const QString &level,
                     std::function<void(QJsonObject)> done);
    void getForkMessages(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void fork(const QJsonObject &target, const QString &entryId, std::function<void(QJsonObject)> done);
    void clone(const QJsonObject &target, std::function<void(QJsonObject)> done);
    void uiResponse(const QJsonObject &input, std::function<void(QJsonObject)> done);

    /** Pending interactive requests for one session (Web polling / diagnostics). */
    QJsonArray pendingUiRequests(const QString &sessionId) const;

private:
    using CommandDone = std::function<void(bool ok, const QJsonValue &value, const QString &error)>;

    struct DeliveryEntry {
        qint64 createdAt = 0;
        bool settled = false;
        QJsonObject result;
        QVector<std::function<void(const QJsonObject &)>> waiters;
    };
    struct ActivationWait {
        QString sessionId;
        std::function<void(QJsonObject)> done;
    };

    // lifecycle helpers
    AgentSession *agent(const QString &agentId) const;
    AgentSession *requireAgent(const QString &agentId) const;
    /** Drop one runtime plus its per-agent recording state (`clearAgentState`). */
    void forgetAgent(const QString &agentId);
    /**
     * Clear one dead runtime's per-agent state (oracle `AgentManager.clearAgentState`).
     *
     * Called from every terminal process exit (crash, failed clean-exit reconnect) before
     * the detach frame. The oracle comment is the reason: a crashed/reconnecting runtime
     * does not always produce a detach frame, so leaving the subagent rows behind shows a
     * permanent yellow dot in the sidebar; a pending ask that can never be answered leaves
     * a dead dialog; stale streaming/perf accumulators would be inherited by the next
     * activation of the same session.
     */
    void clearAgentRuntimeState(AgentSession &session);
    void emitForAgent(const QString &agentId, const QString &channel, const QJsonValue &payload);
    /** Answer a dialog ask that has no bound runtime (`cancelUnboundUiRequest`). */
    void cancelUnboundUiRequest(const QString &agentId, const QJsonObject &request);
    void emitState();
    void emitRuntimeState(const QString &agentId);
    void emitDetach(const Target &target);
    QJsonArray tabsJson() const;

    // activation
    void runActivation(const QString &sessionId, std::function<void(QJsonObject)> done);
    /**
     * Reap a runtime that never became usable (failed activation/restart handshake).
     *
     * Two independent duties, deliberately split:
     *  - the **process**: any created-but-unbound agent is closed and forgotten, deferred
     *    off its own RPC callback stack, so a file-backed session cannot accumulate one
     *    orphan pi per retry (oracle `waitUntilReady` catch -> `agents.stop`);
     *  - the **catalog record**: only a `--no-session` entry is transient, so only it is
     *    removed and announced (`failAnonymousActivation`). A file-backed entry keeps its
     *    durable identity and may simply be retried.
     * `dropTransientRecord=false` keeps even an anonymous record (restart failure).
     */
    void discardFailedActivation(const CatalogEntry &entry, const QString &agentId,
                                 bool dropTransientRecord = true);
    void createAgent(const CatalogEntry &entry, std::function<void(AgentSession *, const QString &)> done);
    void loadProjection(AgentSession &session, std::function<void()> done);
    void applyPreferences(AgentSession &session, const CatalogEntry &entry, std::function<void()> done);
    void publishState(AgentSession &session);
    /** Reload the projection after a session-file mutation (switch_session already ran). */
    void reloadProjection(const QString &agentId, CommandDone finish);
    /** Bind/rebind a session and drop its pending interactive requests (oracle `bind`). */
    int bindSession(const QString &sessionId, const QString &agentId);
    /**
     * Commit a held replacement reservation (`Bindings::completeReplacement`) and drop the
     * target session's pending asks, exactly like `bindSession` does after a plain bind.
     */
    int completeReplacement(const QString &sessionId, const QString &agentId,
                            const QString &newSessionId, const QString &newAgentId);
    /**
     * After fork/clone: read the new session file, mint its catalog identity, rebind.
     *
     * The replacement reservation must already be held (see `runReplacement`); this
     * consumes it either by binding the new target or by dropping it (fail closed).
     */
    void runReplacement(const Target &target, const QString &command, const QJsonObject &params,
                        std::function<void(QJsonObject)> done);
    void refreshAfterReplacement(const Target &target, const QJsonObject &data,
                                 std::function<void(QJsonObject)> finish);
    /** Re-bind the original session/agent after a refused or failed replacement. */
    void restoreReplacement(const Target &target);
    QString resolveProjectPath(const QString &projectId) const;
    QString normalizeSessionPath(const QString &path, const QString &projectPath) const;

    // command plumbing
    bool requireTarget(const QJsonObject &target, Target *out, CommandError *error) const;

    // manual compaction (RuntimeCompact.cpp)
    /**
     * Manual-compaction completion (oracle `finishManualCompaction`).
     *
     * Releases the in-flight gates, then restores a sendable status unless pi is still
     * compacting, a follow-up run started, a turn is still live, or the runtime is in a
     * terminal/starting state.
     */
    void finishManualCompaction(AgentSession &session);
    /** `AgentRuntimeState` snapshot (the value half of `AgentManager.getRuntimeState`). */
    void fetchRuntimeState(const QString &agentId, std::function<void(QJsonObject)> done);

    // pi process swap (oracle `reattachProcess`)
    /** Rebuild the launch argv/env for an existing session's *current* session file. */
    pilaunch::Launch buildSessionLaunch(const AgentSession &session, const QString &sessionPath) const;
    /**
     * Replace a dead pi process with a new one for the same session.
     *
     * Keeps `agentId` and `runtimeGeneration` (the renderer's target stays valid), but
     * fails closed when the binding moved meanwhile: a replaced runtime must never be
     * revived by a stale compaction.
     */
    void reattachProcess(const QString &agentId, const Target &target,
                         std::function<void(bool ok, const QString &error)> done);

    void runTarget(const QJsonObject &target,
                   std::function<void(AgentSession &, const Target &, CommandDone)> operation,
                   std::function<void(QJsonObject)> done);
    void runHistoryMutation(const QJsonObject &target,
                            std::function<void(AgentSession &, const Target &, CommandDone)> operation,
                            std::function<void(QJsonObject)> done);
    /** Serialize edit/delete/resend per session; `task` must call `finished` exactly once. */
    void queueHistoryMutation(const QString &sessionId, std::function<void(std::function<void()>)> task);
    void startNextHistoryMutation(const QString &sessionId);

    // delivery cache
    void pruneDelivery();
    void settleDelivery(const QString &key, const QJsonObject &result);
    QString deliveryKey(const QString &sessionId, const QString &requestId) const;

    // events
    EventHooks hooksFor(AgentSession &session);
    /** Fan one unsolicited pi event out to the raw observers (LAN web stream). */
    void publishPiEvent(const QString &agentId, AgentSession &session, const QJsonObject &event);

    // idle fallback (RuntimeSettle.cpp)
    /**
     * Remember that this runtime never emits `agent_settled` (oracle `rustRuntimeAgents`).
     *
     * Witness is `agent_start` carrying a string `sessionId`: pi_agent_rust/Pi-Bolt stamp
     * it, TypeScript pi does not. The flag decides the watchdog delay (250 ms vs 5 s) and
     * lives as long as the agent id (a reattach keeps it).
     */
    void noteRuntimeKind(const QString &agentId, const QJsonObject &event);
    /**
     * Arm the idle-confirmation watchdog (`AgentManager.settleTimer`).
     *
     * Captures the transport epoch and run generation at arm time, so a timer that fires
     * after a restart/new run is a no-op instead of settling the replacement.
     */
    void scheduleSettledWatchdog(const QString &agentId, agentruntime::SettleWatchdog reason);
    /**
     * `AgentManager.markIdleIfPiReportsNoWork`: confirm with `get_state` that pi has no work
     * left and settle the turn without an `agent_settled` event.
     */
    void markIdleIfPiReportsNoWork(const QString &agentId, quint64 clientEpoch, int generation);
    /** Local "the turn ended" gates shared by the poll and its post-round-trip re-check. */
    bool locallySettled(const AgentSession &session, quint64 clientEpoch, int generation) const;
    /** Settle a turn whose runtime never reported `agent_settled`. */
    void settleWithoutSettled(AgentSession &session);
    /** Publish a synthetic `agent_settled` to the raw observers only (LAN stream finish). */
    void publishLocalSettled(const QString &agentId, AgentSession &session);
    /**
     * Session-scoped notice that does not require a binding yet.
     *
     * Oracle `SessionRuntimeBridge.emitSessionNotice`: `applyPreferences` runs *before*
     * `bind`, so the thinking-level downgrade toast would otherwise be dropped by the
     * envelope's binding lookup. The generation is 0 until the runtime is bound, and the
     * renderer's notice branch deliberately does not fence on it.
     */
    void emitNoticeForSession(const QString &sessionId, const QString &agentId,
                              const QJsonObject &payload);
    /**
     * `AgentManager.persistAdjustedThinking`: write the level pi actually accepted and
     * tell the user why the stored preference changed.
     */
    void persistAdjustedThinking(const QString &sessionId, const QString &agentId,
                                 const QString &fromLevel, const QString &toLevel);
    /** Stored preference clamped for its model (`desiredThinkingLevel`). */
    QString desiredThinkingLevel(const CatalogEntry &entry) const;
    /**
     * Apply the catalog's thinking level at activation (`applyPreferences`).
     *
     * Runs before the runtime is bound, so the downgrade notice goes through
     * `emitNoticeForSession` with generation 0. Calls `done` exactly once.
     */
    void applyThinkingPreference(AgentSession &session, const CatalogEntry &entry,
                                 std::function<void()> done);
    /**
     * `SessionRuntimeCoordinator.alignThinkingLevelWithModel`.
     *
     * After a model switch: clamp an extended level the new model does not declare to
     * `high`, and re-apply the user's level when pi reset it although the model still
     * declares it. Base levels are untouched (model capability does not apply), and an
     * unreadable `models.json` skips the clamp instead of guessing.
     *
     * Calls `done` exactly once; a failed alignment never fails the model switch (the
     * oracle only logs a warning), so the caller keeps reporting the switch as accepted.
     */
    void alignThinkingAfterModelChange(const QString &sessionId, const QString &agentId,
                                      const QString &level, const QString &provider,
                                      const QString &modelId, const QString &runtimeLevel,
                                      std::function<void()> done);
    /**
     * `models.json` support bits for one model.
     *
     * False means "unknown" (unreadable/corrupt config): the caller must skip the clamp
     * rather than downgrade the user's preference on a transient I/O error.
     */
    bool resolveThinkingSupport(const QString &provider, const QString &modelId,
                                modellist::ThinkingSupport *support) const;
    /**
     * `AgentManager.scheduleAbortSettledFallback` + `escalateAbortIfStillRunning`.
     *
     * A tool that blocks pi's event loop ignores the abort RPC; after the settled
     * fallback window the desktop re-checks `get_state`, sends `abort_bash`, repeats the
     * abort and finally warns the user that the stop is slow. Fenced on the transport
     * epoch and the sealed run generation so a replaced process is never killed.
     */
    void scheduleAbortEscalation(const QString &agentId, quint64 clientEpoch, int sealedGeneration);
    void escalateAbortIfStillRunning(const QString &agentId, quint64 clientEpoch, int sealedGeneration);
    void observeUiRequest(const Target &target, const AgentSession::PendingUi &request);
    /**
     * Drop every pending interactive request of a session.
     *
     * Oracle `clearPendingUiRequests`: called when a runtime unbinds (stop, restart) and
     * when a replacement reserves the binding (fork/clone). Leaving a stale request makes
     * a late answer forward to a process that never asked the question.
     */
    void clearPendingUi(const QString &sessionId);

    /**
     * Full `AgentRuntimeState` projection for one agent.
     *
     * Both `agents:runtime-state` and `sessions:runtime-state` resolve through here so a
     * polled value and a pushed value can never diverge. The session-file usage scan is
     * cached by (size, mtime) like the oracle's `createCacheHitStatsReader`.
     */
    QJsonObject buildRuntimeState(const QJsonObject &state, const QJsonObject &stats,
                                  AgentSession &session);

    Deps m_deps;
    /**
     * Thread that owns every runtime object (set in the constructor).
     *
     * `AgentSession`/`PiEventClient`/`QProcess` must only be touched from here; see
     * `postToOwner`. Compared by id so a dangling QThread pointer can never be read.
     */
    Qt::HANDLE m_ownerThreadId = nullptr;
    Bindings m_bindings;
    /** (size, mtime) cache for the per-session cache-hit scan (`cacheHitStats.ts`). */
    cachehit::Reader m_cacheHits;
    std::map<QString, std::unique_ptr<AgentSession>> m_agents;
    QHash<QString, QVector<std::function<void(QJsonObject)>>> m_activationWaiters;
    QHash<QString, DeliveryEntry> m_delivery;
    QHash<QString, AgentSession::PendingUi> m_pendingUi;
    QHash<QString, QVector<std::function<void(std::function<void()>)>>> m_historyTails;
    QHash<QString, QJsonArray> m_commandCache;
    QHash<int, PiEventObserver> m_piObservers;
    QHash<int, std::function<void()>> m_stateObservers;
    /** Agents whose lifecycle serializer never emits `agent_settled` (oracle set). */
    QSet<QString> m_rustRuntimeAgents;
    int m_nextObserverId = 1;
    QString m_focusedSessionId;
    bool m_shutdown = false;
};

} // namespace runtime
