#pragma once

#include <QJsonObject>
#include <QString>

/**
 * Last-reply performance metrics (port of AgentManager's `messagePerfByAgent` /
 * `lastPerfByAgent`).
 *
 * `getRuntimeState` returns TTFT / total duration / tok/s for the most recent assistant
 * reply; the status panel renders them as separate rows from the cumulative token
 * counters. They are settled locally from pi events, never by an extra RPC:
 *  - ttftMs  = first content delta (text first, thinking fallback) - request start;
 *  - totalMs = settle time - request start;
 *  - tps     = output tokens / (settle - first delta), so the prefill wait is excluded.
 */
namespace agentmetrics {

struct ReplyPerf {
    bool valid = false;
    bool hasTtft = false;
    double ttftMs = 0;
    double totalMs = 0;
    bool hasTps = false;
    double tps = 0;
    double at = 0;
};

class ReplyPerfTracker {
public:
    /** `sendPrompt` dispatch time; prefer it over the first event's arrival time. */
    void promptRequested(qint64 now);
    /** `message_start` / `message_update.start`: open the timer once per reply. */
    void messageStarted(qint64 now);
    void firstDelta(qint64 now);
    void firstText(qint64 now);
    /**
     * Settle the open reply with pi's final assistant message.
     *
     * Returns true only when a reply was actually open (idempotent for the duplicate
     * `message_end` / `message_update done` pair) and fills `out` with the metrics.
     */
    bool settle(const QJsonObject &message, qint64 now, ReplyPerf *out);
    /** Last settled metrics; survives the reply so polling keeps reporting them. */
    const ReplyPerf &last() const { return m_last; }
    /** Drop the open timer without touching the last settled metrics. */
    void resetOpen();
    void clear();

private:
    bool m_open = false;
    qint64 m_startedAt = 0;
    qint64 m_firstDeltaAt = 0;
    qint64 m_firstTextAt = 0;
    bool m_hasRequestedAt = false;
    qint64 m_requestedAt = 0;
    ReplyPerf m_last;
};

} // namespace agentmetrics
