#pragma once

#include "AgentMetrics.h"
#include "CacheHitStats.h"

#include <QJsonObject>
#include <QJsonValue>
#include <QString>
#include <QStringList>

/**
 * Shared vocabulary for the pi session runtime domain.
 *
 * Ports the observable contract of src/main/sessions/SessionRuntimeCoordinator.ts and
 * src/main/pi/AgentManager.ts: a session owns at most one runtime, every runtime is
 * identified by `sessionId + agentId + runtimeGeneration`, and every command result is
 * either `{ok:true,value}` or `{ok:false,error:{code,...}}` (SessionCommandResult).
 *
 * The generation is bumped on every (re)bind. It is the only defence against a late
 * reply from a replaced process being attributed to the current one, so it is carried
 * on every target, lease and runtime event.
 */
namespace runtime {

/** Stable session identity + transient process handle + binding generation. */
struct Target {
    QString sessionId;
    QString agentId;
    int runtimeGeneration = 0;

    bool operator==(const Target &other) const
    {
        return sessionId == other.sessionId && agentId == other.agentId
            && runtimeGeneration == other.runtimeGeneration;
    }
};

/** AgentTab wire shape (src/shared/types/agent.ts). */
struct Tab {
    QString id;
    QString projectId;
    QString cwd;
    QString title;
    /** starting | idle | running | error | closed */
    QString status = QStringLiteral("starting");
    QString piSessionId;
    QString deckSessionId;
    QString sessionPath;
    QString sessionEnvironment;
    QString sessionSource;
    bool isInternalSubagent = false;
    QString wslDistro;
    QString wslUser;
    QString importedSourceId;
    bool noSession = false;
    int runtimeGeneration = 0;
    qint64 createdAt = 0;
    int compactionCount = 0;
    /** Local streaming/tool flags (AgentRuntimeState patch source, not pi state). */
    bool isStreaming = false;
    bool isExecutingTool = false;
    QString executingToolName;
    int toolStateSequence = 0;
    /**
     * Why the tab is in `error`. "turn" = an API failure inside one turn while the pi
     * process is still alive (editable/deletable, reusable); "startup" = the process
     * never became usable, so the binding must be dropped.
     */
    QString errorKind;
};

/** SessionCommandError codes shared with the renderer. */
namespace errorcode {
constexpr auto kSessionNotFound = "SESSION_NOT_FOUND";
constexpr auto kMessageNotFound = "MESSAGE_NOT_FOUND";
constexpr auto kRuntimeUnavailable = "SESSION_RUNTIME_UNAVAILABLE";
constexpr auto kRuntimeChanged = "SESSION_RUNTIME_CHANGED";
constexpr auto kRuntimeBusy = "SESSION_RUNTIME_BUSY";
constexpr auto kCommandFailed = "SESSION_COMMAND_FAILED";
constexpr auto kModelNotFound = "SESSION_MODEL_NOT_FOUND";
constexpr auto kModelRequired = "SESSION_MODEL_REQUIRED";
} // namespace errorcode

/** One failed command; `code` is a SessionCommandErrorCode. */
struct CommandError {
    QString code = QString::fromLatin1(errorcode::kCommandFailed);
    QString debugDetails;
    /** Only set for SESSION_MODEL_NOT_FOUND (i18n `{model}` placeholder). */
    QString model;
    bool needsRestart = false;

    static CommandError of(const QString &code, const QString &details)
    {
        CommandError error;
        error.code = code;
        error.debugDetails = details;
        return error;
    }
};

/** `{ok:true,value}` for a command that returns a value. */
QJsonObject okResult(const QJsonValue &value);
/** `{ok:true,value:{target,value}}` for a targeted command. */
QJsonObject targetedOk(const Target &target, const QJsonValue &value);
/** `{ok:false,error:{code,debugDetails,params?,needsRestart?}}`. */
QJsonObject errorResult(const CommandError &error);

/**
 * Map an arbitrary failure message onto a SessionCommandErrorCode.
 *
 * Mirrors the oracle's `commandFailure` ladder: an explicit code wins, then the
 * message is classified (message/entry before the generic "not found", model before
 * session) so the renderer shows the right guidance instead of "session deleted".
 */
CommandError classifyFailure(const QString &message, const QString &explicitCode = QString());

/** AgentTab -> wire JSON (omits absent optional fields, like the oracle). */
QJsonObject tabJson(const Tab &tab);

/** SessionRuntimeInfo -> wire JSON. */
QJsonObject runtimeInfoJson(const Target &target, const Tab &tab);

/**
 * AgentRuntimeState assembled from pi `get_state` / `get_session_stats`.
 *
 * `manualCompactionInFlight` is the runtime's own gate: the oracle computes
 * `isCompacting = state.isCompacting || rpcCompactingAgents || compactingAgents`, and pi
 * does not report a compaction it has not acknowledged yet, so a manual compact that is
 * still on the wire — or any `compaction_start` pi already sent — is only visible here.
 *
 * `cacheHits` is the session-file usage scan and `perf` the last settled reply metrics
 * (oracle `AgentManager.getRuntimeState`); both are local-only and never cost an RPC.
 */
QJsonObject runtimeStateJson(const QJsonObject &state, const QJsonObject &stats, const Tab &tab,
                             bool manualCompactionInFlight = false,
                             const cachehit::Stats &cacheHits = cachehit::Stats{},
                             const agentmetrics::ReplyPerf &perf = agentmetrics::ReplyPerf{});

/** Read the first finite number among candidate JSON paths, like `pickNumber`. */
QJsonValue pickNumber(std::initializer_list<QJsonValue> candidates);

/** Strip terminal ANSI colour sequences (extension notices carry them). */
QString stripAnsi(const QString &text);

} // namespace runtime
