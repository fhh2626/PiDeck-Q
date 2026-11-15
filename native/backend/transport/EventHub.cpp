#include "EventHub.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <QUuid>

#include <chrono>

namespace {

constexpr qint64 kMaxFrameBytes = 32LL * 1024LL * 1024LL;

qint64 monotonicNowMs()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

} // namespace

EventHub::EventHub(Limits limits, QObject *parent)
    : QObject(parent), m_limits(limits), m_generation(QUuid::createUuid().toString(QUuid::WithoutBraces))
{
    m_eventTimes.resize(m_limits.timeRingSize);
    m_eventTimes.fill(-1);
}

void EventHub::resetGeneration()
{
    m_generation = QUuid::createUuid().toString(QUuid::WithoutBraces);
    m_eventSeq = 0;
    m_history.clear();
    m_historyBytes = 0;
    m_eventTimes.fill(-1);
}

quint64 EventHub::broadcast(const QString &channel, const QJsonArray &args)
{
    const QByteArray payload = QJsonDocument(QJsonObject{
        {QStringLiteral("channel"), channel},
        {QStringLiteral("args"), args},
    }).toJson(QJsonDocument::Compact);
    const qint64 bytes = payload.size();
    if (bytes > kMaxFrameBytes) {
        // The frame cannot be represented inside the protocol budget. Announce the
        // loss so the renderer can re-pull full state instead of silently missing it.
        if (m_oversizedSink) m_oversizedSink(channel, bytes);
        if (m_replayGapSink) m_replayGapSink(QStringLiteral("oversized-event"), monotonicNowMs(), true);
        return appendPayload(
            QJsonDocument(QJsonObject{
                {QStringLiteral("channel"), QStringLiteral("native.resyncRequired")},
                {QStringLiteral("args"), QJsonArray{QJsonObject{
                     {QStringLiteral("channel"), channel},
                     {QStringLiteral("bytes"), bytes},
                 }}},
            }).toJson(QJsonDocument::Compact),
            QStringLiteral("native.resyncRequired"), -1);
    }
    return appendPayload(payload, channel, bytes);
}

quint64 EventHub::appendPayload(const QByteArray &payload, const QString &channel, qint64 payloadBytes)
{
    const quint64 seq = ++m_eventSeq;
    const QByteArray header = QByteArrayLiteral("id: ") + QByteArray::number(seq) + QByteArrayLiteral("\ndata: ");
    QByteArray frame = header;
    frame.append(payload);
    frame.append("\n\n");
    // Header and trailing blank line are ASCII, so the byte count is exact without
    // re-scanning multi-megabyte payloads.
    const qint64 bytes = payloadBytes >= 0 ? qint64(header.size()) + payloadBytes + 2 : frame.size();
    m_eventTimes[int(seq % quint64(m_limits.timeRingSize))] = monotonicNowMs();
    if (bytes >= m_limits.largeFrameLogBytes) reportLargeFrame(channel, bytes);

    m_history.append(Record{seq, frame, bytes});
    m_historyBytes += bytes;
    while (m_history.size() > m_limits.maxHistory || m_historyBytes > m_limits.maxHistoryBytes) {
        if (m_history.isEmpty()) break;
        m_historyBytes -= m_history.first().bytes;
        m_history.removeFirst();
    }
    if (m_frameSink) m_frameSink(seq, frame, bytes);
    return seq;
}

void EventHub::reportLargeFrame(const QString &channel, qint64 bytes)
{
    if (m_limits.largeFrameLogIntervalMs <= 0) {
        if (m_largeFrameSink) m_largeFrameSink(channel, bytes, 0);
        return;
    }
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (now - m_lastLargeFrameLogAt < m_limits.largeFrameLogIntervalMs) {
        ++m_suppressedLargeFrames;
        return;
    }
    m_lastLargeFrameLogAt = now;
    const int suppressed = m_suppressedLargeFrames;
    m_suppressedLargeFrames = 0;
    if (m_largeFrameSink) m_largeFrameSink(channel, bytes, suppressed);
}

EventHub::Replay EventHub::replay(quint64 lastEventId, bool hasLastEventId)
{
    Replay result;
    result.lastSeq = m_eventSeq;
    if (!hasLastEventId) return result;

    const quint64 oldestSeq = m_history.isEmpty() ? m_eventSeq + 1 : m_history.first().seq;
    if (lastEventId < oldestSeq - 1) {
        result.gap = true;
        result.gapReason = QStringLiteral("event-history-truncated");
        const qint64 lostSince = lostSinceMs(lastEventId, true, m_generation);
        result.hasGapLostSince = lostSince >= 0;
        result.gapLostSinceMs = lostSince;
        return result;
    }
    for (const Record &record : std::as_const(m_history)) {
        if (record.seq > lastEventId) result.frames.append(record.frame);
    }
    return result;
}

QByteArray EventHub::controlFrame(const QString &channel, const QJsonValue &payload) const
{
    const QByteArray body = QJsonDocument(QJsonObject{
        {QStringLiteral("channel"), channel},
        {QStringLiteral("args"), QJsonArray{payload}},
    }).toJson(QJsonDocument::Compact);
    return QByteArrayLiteral("id: ") + QByteArray::number(m_eventSeq) + QByteArrayLiteral("\ndata: ") + body
        + QByteArrayLiteral("\n\n");
}

qint64 EventHub::lostSinceMs(quint64 rendererSeq, bool hasRendererSeq, const QString &rendererGeneration) const
{
    if (!rendererGeneration.isEmpty() && rendererGeneration != m_generation) return -1;
    if (!hasRendererSeq) return -1;
    const quint64 firstLostSeq = rendererSeq + 1;
    if (firstLostSeq > m_eventSeq) return -1;
    if (m_eventSeq - firstLostSeq >= quint64(m_limits.timeRingSize)) return -1;
    return m_eventTimes.at(int(firstLostSeq % quint64(m_limits.timeRingSize)));
}

EventHub::HeartbeatState EventHub::heartbeatState(bool hasRendererSeq, quint64 rendererSeq,
                                                  const QString &rendererGeneration) const
{
    HeartbeatState state;
    state.eventSeq = m_eventSeq;
    state.generation = m_generation;
    // A sequence gap is a correctness failure, not a throughput metric: one missed
    // terminal event can leave the renderer inconsistent.
    state.healthy = !rendererGeneration.isEmpty() && rendererGeneration == m_generation
        && hasRendererSeq && rendererSeq >= m_eventSeq;
    return state;
}
