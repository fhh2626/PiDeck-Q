#pragma once

#include <QObject>
#include <QString>
#include <QTimer>

#include <functional>

/**
 * Coalescing throttle for "the renderer lost frames, re-push full state" requests.
 *
 * Port of src/native-node/transport/liveResyncCoalescer.ts. Three rules, each of which
 * exists because of an observed failure mode:
 *
 *  - the first request in a window runs immediately, the rest merge into one trailing run
 *    at the end of the window. Dropping them instead would leave a second reconnecting
 *    client permanently stale: its cursor jumps to the newest seq on
 *    `native.resyncRequired`, so the first re-push is older than its cursor.
 *  - a merged request keeps the *earliest* lost-since; if any request has an unknown
 *    start the merge is unknown (full re-push).
 *  - requests raised synchronously *by* the re-push itself are ignored. A re-push whose
 *    frame exceeds the single-frame limit reports `oversized-event` again; scheduling that
 *    as a trailing re-push would repeat forever, once per window.
 */
namespace liveresync {

enum class Reason { StalledEventCursor, EventHistoryTruncated, OversizedEvent };

/** Wire string used in diagnostics (`stalled-event-cursor`, ...). */
QString reasonString(Reason reason);

struct Request {
    Reason reason = Reason::EventHistoryTruncated;
    bool hasLostSinceMs = false;
    qint64 lostSinceMs = 0;
};

class Coalescer : public QObject {

public:
    using Run = std::function<void(const Request &)>;
    using Observe = std::function<void(const Request &)>;

    explicit Coalescer(QObject *parent = nullptr);

    void setWindowMs(int windowMs) { m_windowMs = windowMs > 0 ? windowMs : 1; }
    int windowMs() const { return m_windowMs; }

    void setRun(Run run) { m_run = std::move(run); }
    void setOnCoalesced(Observe observer) { m_onCoalesced = std::move(observer); }
    void setOnReentrantIgnored(Observe observer) { m_onReentrantIgnored = std::move(observer); }
    void setOnError(std::function<void(const Request &, const QString &)> handler) { m_onError = std::move(handler); }

    /** Request a re-push; coalesced inside the current window. */
    void request(const Request &request);
    void dispose();
    /** Number of times `run` was invoked (diagnostics/tests). */
    int executions() const { return m_executions; }

private:
    void execute(const Request &request);
    void onWindowEnd();
    void merge(const Request &request);

    QTimer m_timer;
    int m_windowMs = 1'000;
    bool m_disposed = false;
    bool m_running = false;
    bool m_hasPending = false;
    bool m_pendingUnknownStart = false;
    Request m_pending;
    int m_executions = 0;
    Run m_run;
    Observe m_onCoalesced;
    Observe m_onReentrantIgnored;
    std::function<void(const Request &, const QString &)> m_onError;
};

} // namespace liveresync
