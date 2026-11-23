#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QVector>

#include <functional>

class QTimer;

/**
 * Per-agent live RPC log batches (`agents:rpc-log`).
 *
 * Port of `src/main/pi/LiveRpcLogBuffer.ts`. One shared timer coalesces every agent's
 * frames for ~80 ms so a streaming turn cannot flood the SSE channel with one event per
 * pi frame; a quiet burst still drains because the flush re-schedules itself while work
 * remains.
 *
 * Invariants (mirrors the oracle, asserted by `native2LogsParity`):
 *  - at most `kMaxBatch` entries leave in one frame, the remainder follows on the next
 *    tick (100-entry chunks, never dropped);
 *  - a single agent's queue is bounded at `kMaxPending`, keeping the newest entries;
 *  - `drop(agentId)` removes only that agent; `clear()` stops the timer and every queue
 *    so nothing is delivered after shutdown;
 *  - batches are emitted in first-enqueue agent order, matching the Map iteration the
 *    oracle relies on.
 */
namespace rpclog {

class LiveBuffer : public QObject {
public:
    static constexpr int kDefaultFlushMs = 80;
    static constexpr int kMaxBatch = 100;
    static constexpr int kMaxPending = 1000;

    struct Deps {
        std::function<void(const QJsonObject &batch)> deliver;
        int flushMs = kDefaultFlushMs;
    };

    explicit LiveBuffer(Deps deps, QObject *parent = nullptr);

    /** Queue one record; the flush timer is shared by every agent. */
    void enqueue(const QJsonObject &entry);
    /** Forget one agent's queued entries (runtime disposed). */
    void drop(const QString &agentId);
    /** Shutdown: cancel the timer and every queued entry. */
    void clear();

    /** Queued entry count for one agent (diagnostics/tests). */
    int pendingFor(const QString &agentId) const;
    int pendingTotal() const;

private:
    struct Pending {
        QString agentId;
        QJsonArray entries;
    };

    void schedule();
    void flush();

    Deps m_deps;
    QTimer *m_timer = nullptr;
    QVector<Pending> m_pending;
    bool m_flushing = false;
};

} // namespace rpclog
