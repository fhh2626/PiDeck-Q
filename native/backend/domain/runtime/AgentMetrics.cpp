#include "AgentMetrics.h"

namespace agentmetrics {
namespace {

QJsonValue pickNumber(std::initializer_list<QJsonValue> candidates)
{
    for (const QJsonValue &candidate : candidates) {
        if (!candidate.isDouble()) continue;
        const double value = candidate.toDouble();
        if (std::isfinite(value)) return candidate;
    }
    return QJsonValue(QJsonValue::Undefined);
}

} // namespace

void ReplyPerfTracker::promptRequested(qint64 now)
{
    m_hasRequestedAt = true;
    m_requestedAt = now;
}

void ReplyPerfTracker::messageStarted(qint64 now)
{
    if (m_open) return;
    // Oracle `ensurePerfTimer`: the sendPrompt time includes queueing, so it is the
    // honest TTFT origin; the first event arrival is only a fallback (continuations).
    m_open = true;
    m_startedAt = m_hasRequestedAt ? m_requestedAt : now;
    m_hasRequestedAt = false;
    m_firstDeltaAt = 0;
    m_firstTextAt = 0;
}

void ReplyPerfTracker::firstDelta(qint64 now)
{
    if (!m_open || m_firstDeltaAt > 0) return;
    m_firstDeltaAt = now;
}

void ReplyPerfTracker::firstText(qint64 now)
{
    if (!m_open || m_firstTextAt > 0) return;
    m_firstTextAt = now;
}

bool ReplyPerfTracker::settle(const QJsonObject &message, qint64 now, ReplyPerf *out)
{
    if (!m_open) return false;
    const qint64 startedAt = m_startedAt;
    const qint64 firstDeltaAt = m_firstDeltaAt;
    const qint64 firstTextAt = m_firstTextAt;
    resetOpen();

    ReplyPerf perf;
    perf.valid = true;
    perf.totalMs = double(now - startedAt);
    // Content first: in a thinking run the user perceives the body text as the start.
    const qint64 firstContentAt = firstTextAt > 0 ? firstTextAt : firstDeltaAt;
    if (firstContentAt > 0) {
        perf.hasTtft = true;
        perf.ttftMs = double(firstContentAt - startedAt);
    }
    const QJsonObject usage = message.value(QStringLiteral("usage")).toObject();
    const QJsonValue outputTokens = pickNumber({
        usage.value(QStringLiteral("output")),
        usage.value(QStringLiteral("outputTokens")),
        usage.value(QStringLiteral("completion")),
        usage.value(QStringLiteral("completionTokens")),
    });
    if (outputTokens.isDouble() && outputTokens.toDouble() > 0 && firstDeltaAt > 0
        && now > firstDeltaAt) {
        perf.hasTps = true;
        perf.tps = outputTokens.toDouble() / (double(now - firstDeltaAt) / 1000.0);
    }
    perf.at = double(now);
    m_last = perf;
    if (out) *out = perf;
    return true;
}

void ReplyPerfTracker::resetOpen()
{
    m_open = false;
    m_startedAt = 0;
    m_firstDeltaAt = 0;
    m_firstTextAt = 0;
}

void ReplyPerfTracker::clear()
{
    resetOpen();
    m_hasRequestedAt = false;
    m_requestedAt = 0;
    m_last = ReplyPerf{};
}

} // namespace agentmetrics
