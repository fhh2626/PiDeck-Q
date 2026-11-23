#include "RendererHeartbeat.h"

#include <algorithm>

namespace rendererheartbeat {

bool shouldResetAfterSuspend(qint64 tickGapMs, qint64 suspendGapMs)
{
    return tickGapMs >= std::max<qint64>(1, suspendGapMs);
}

bool shouldReloadAfterMissed(qint64 elapsedMs, int windowMs, int missedWindowsBeforeReload)
{
    const qint64 window = std::max(1, windowMs);
    const qint64 threshold = std::max(1, missedWindowsBeforeReload);
    return (std::max<qint64>(0, elapsedMs) / window) >= threshold;
}

RecoveryResult advanceRecovery(const RecoveryState &previous, bool hasRendererSeq, qint64 rendererSeq,
                               bool eventChannelHealthy, int resyncAfter)
{
    RecoveryState next = previous;
    const bool cursorAdvanced = hasRendererSeq && previous.hasRendererSeq && rendererSeq > previous.lastRendererSeq;
    if (hasRendererSeq) {
        next.hasRendererSeq = true;
        next.lastRendererSeq = previous.hasRendererSeq ? std::max(previous.lastRendererSeq, rendererSeq) : rendererSeq;
    }
    const bool recovered = eventChannelHealthy || cursorAdvanced;
    next.consecutiveStalled = recovered ? 0 : previous.consecutiveStalled + 1;

    const int threshold = std::max(1, resyncAfter);
    // A healthy channel resets the backoff; inside a stall the threshold is pushed out
    // after every re-push so the next one costs more stalled heartbeats.
    next.resyncAttempts = recovered ? 0 : previous.resyncAttempts;
    next.nextResyncAtStalled =
        (recovered || next.resyncAttempts == 0) ? threshold : previous.nextResyncAtStalled;

    RecoveryResult result;
    result.shouldResync = !recovered && next.consecutiveStalled >= next.nextResyncAtStalled;
    if (result.shouldResync) {
        const int backoff = std::min(threshold * (1 << (next.resyncAttempts + 1)), kMaxResyncBackoffHeartbeats);
        next.resyncAttempts = next.resyncAttempts + 1;
        next.nextResyncAtStalled = next.consecutiveStalled + backoff;
    }
    result.state = next;
    return result;
}

Watchdog::Watchdog(Deps deps) : m_deps(std::move(deps))
{
    reset();
}

void Watchdog::reset()
{
    const qint64 now = m_deps.now ? m_deps.now() : 0;
    m_lastHeartbeatAt = now;
    m_lastTickAt = now;
    m_reloadInFlight = false;
}

void Watchdog::touch()
{
    m_lastHeartbeatAt = m_deps.now ? m_deps.now() : 0;
}

void Watchdog::tick()
{
    const qint64 now = m_deps.now ? m_deps.now() : 0;
    const qint64 tickGap = now - m_lastTickAt;
    m_lastTickAt = now;
    if (shouldResetAfterSuspend(tickGap, qint64(m_deps.windowMs) * qMax(1, m_deps.missedWindowsBeforeReload))) {
        // The backend itself was suspended; give the page a full grace period instead of
        // reloading it for a gap it did not cause.
        m_lastHeartbeatAt = now;
        return;
    }
    if (m_deps.shouldWatch && !m_deps.shouldWatch()) return;
    if (!shouldReloadAfterMissed(now - m_lastHeartbeatAt, m_deps.windowMs, m_deps.missedWindowsBeforeReload)) return;
    if (m_reloadInFlight) return;
    m_reloadInFlight = true;
    performReload();
}

void Watchdog::performReload()
{
    // Diagnostics must never disable recovery: a failing log call still reloads.
    if (m_deps.onReload) {
        try {
            m_deps.onReload();
        } catch (...) {
            // ignored on purpose
        }
    }
    auto finish = [this]() {
        m_reloadInFlight = false;
        m_lastHeartbeatAt = m_deps.now ? m_deps.now() : 0;
    };
    if (!m_deps.reload) {
        finish();
        return;
    }
    try {
        m_deps.reload(finish);
    } catch (...) {
        finish();
    }
}

} // namespace rendererheartbeat
