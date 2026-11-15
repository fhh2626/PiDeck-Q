#include "LiveResyncCoalescer.h"

#include <exception>

namespace liveresync {

QString reasonString(Reason reason)
{
    switch (reason) {
    case Reason::StalledEventCursor: return QStringLiteral("stalled-event-cursor");
    case Reason::EventHistoryTruncated: return QStringLiteral("event-history-truncated");
    case Reason::OversizedEvent: return QStringLiteral("oversized-event");
    }
    return QStringLiteral("event-history-truncated");
}

Coalescer::Coalescer(QObject *parent) : QObject(parent)
{
    m_timer.setSingleShot(true);
    connect(&m_timer, &QTimer::timeout, this, [this] { onWindowEnd(); });
}

void Coalescer::request(const Request &request)
{
    if (m_disposed) return;
    if (m_running) {
        // Raised by the re-push itself; scheduling it would loop forever.
        if (m_onReentrantIgnored) m_onReentrantIgnored(request);
        return;
    }
    if (m_timer.isActive()) {
        merge(request);
        if (m_onCoalesced) m_onCoalesced(request);
        return;
    }
    execute(request);
}

void Coalescer::dispose()
{
    m_disposed = true;
    m_timer.stop();
    m_hasPending = false;
    m_pendingUnknownStart = false;
}

void Coalescer::merge(const Request &request)
{
    if (!request.hasLostSinceMs) m_pendingUnknownStart = true;
    if (!m_hasPending) {
        m_pending = request;
        m_hasPending = true;
        return;
    }
    const qint64 previous = m_pending.hasLostSinceMs ? m_pending.lostSinceMs : 0;
    const qint64 incoming = request.hasLostSinceMs ? request.lostSinceMs : 0;
    const bool hasStart = !m_pendingUnknownStart && m_pending.hasLostSinceMs && request.hasLostSinceMs;
    m_pending = Request{request.reason, hasStart, hasStart ? qMin(previous, incoming) : 0};
}

void Coalescer::execute(const Request &request)
{
    m_timer.start(m_windowMs);
    m_running = true;
    ++m_executions;
    try {
        if (m_run) m_run(request);
    } catch (const std::exception &error) {
        if (m_onError) m_onError(request, QString::fromUtf8(error.what()));
    } catch (...) {
        if (m_onError) m_onError(request, QStringLiteral("Live resync failed"));
    }
    m_running = false;
}

void Coalescer::onWindowEnd()
{
    if (m_disposed) return;
    if (!m_hasPending) return;
    const Request pending = m_pending;
    m_hasPending = false;
    m_pendingUnknownStart = false;
    execute(pending);
}

} // namespace liveresync
