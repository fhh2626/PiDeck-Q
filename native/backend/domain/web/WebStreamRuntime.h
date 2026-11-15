#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QVector>

/**
 * Run admission + runtime reconciliation for the LAN AI SDK stream.
 *
 * Port of `src/main/web/webStreamRuntime.ts`. The router needs one decision per opened
 * response: is this socket allowed to wait before anything runs (POST /api/chat), or
 * must it finish immediately when there is nothing to observe (GET /stream)?
 *
 * Getting this wrong leaks long-lived connections: `useChat` keeps a POST open until it
 * sees `finish`, and a reconnecting browser keeps a GET open for a session that is idle.
 */
namespace webstream {

/** `SessionRuntimeTarget`: the identity a stream/run is pinned to. */
struct Target {
    QString sessionId;
    QString agentId;
    int runtimeGeneration = 0;

    bool operator==(const Target &other) const
    {
        return sessionId == other.sessionId && agentId == other.agentId
            && runtimeGeneration == other.runtimeGeneration;
    }
    QJsonObject toJson() const;
};

/** The subset of `SessionRuntimeInfo` the stream policy reads. */
struct RuntimeInfo {
    QString sessionId;
    QString agentId;
    int runtimeGeneration = 0;
    QString status;
};

/** Parse `sessions:list-runtimes` rows; rows without an identity are skipped. */
QVector<RuntimeInfo> readRuntimeInfos(const QJsonArray &runtimes);

/**
 * One run-level admission mode:
 *  - `dispatch` (POST /api/chat) opens the stream *before* the prompt is sent, so
 *    idle/missing/starting are all legal preparation states and must not finish it;
 *  - `observe` (GET /stream) only follows an execution that already exists, so no
 *    observable runtime means "finish now" instead of "wait forever".
 */
enum class Admission { Dispatch, Observe };

struct Reconcile {
    bool hasTarget = false;
    Target target;
    bool finish = false;
};

/**
 * Decide whether a run keeps following a runtime, and whether it should finish.
 *
 * `target` is the run's pinned identity (`hasTarget == false` before the first pin),
 * `runtime` the session's current runtime (null when the session owns none).
 */
Reconcile reconcile(const Target *target, const RuntimeInfo *runtime, Admission admission);

} // namespace webstream
