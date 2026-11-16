#pragma once

#include <QByteArray>
#include <QJsonArray>
#include <QJsonValue>
#include <QList>
#include <QObject>
#include <QString>
#include <QVector>

#include <functional>

/**
 * Replayable desktop event channel (SSE) state.
 *
 * The renderer keeps a monotonic cursor and reconnects with `Last-Event-ID`; the
 * server therefore has to own a single sequence namespace, a bounded history that
 * can be replayed, and a generation id that changes whenever the namespace resets.
 * Mirrors src/native-node/transport/NativeRendererServer.ts:
 *   - seq is assigned per appended frame and never reused inside a generation;
 *   - history is capped by both frame count (4096) and bytes (32 MiB);
 *   - a frame larger than 32 MiB is dropped and replaced by `native.resyncRequired`;
 *   - a cursor older than the retained history produces `native.resyncRequired`
 *     instead of a silently incomplete replay;
 *   - a 65536-entry time ring answers "when was the first lost frame produced"
 *     so the owner can decide how much state to re-push.
 */
class EventHub : public QObject {

public:
    struct Limits {
        int maxHistory = 4'096;
        qint64 maxHistoryBytes = 32LL * 1024LL * 1024LL;
        int timeRingSize = 65'536;
        int largeFrameLogBytes = 256 * 1024;
        int largeFrameLogIntervalMs = 5'000;
    };

    struct Replay {
        /** True when the cursor is older than the retained history. */
        bool gap = false;
        /** Reason for the gap, matching the oracle's reason strings. */
        QString gapReason;
        qint64 gapLostSinceMs = -1;
        bool hasGapLostSince = false;
        QList<QByteArray> frames;
        quint64 lastSeq = 0;
    };

    EventHub();
    explicit EventHub(Limits limits, QObject *parent = nullptr);

    const QString &generation() const { return m_generation; }
    quint64 eventSeq() const { return m_eventSeq; }

    /** Append and assign a sequence number. Returns 0 when the frame was dropped. */
    quint64 broadcast(const QString &channel, const QJsonArray &args);

    /** Frames newer than `lastEventId`, or a gap marker when history no longer covers it. */
    Replay replay(quint64 lastEventId, bool hasLastEventId);

    /** Control frames are delivered to one client and carry the current seq. */
    QByteArray controlFrame(const QString &channel, const QJsonValue &payload) const;

    /**
     * Production time (monotonic ms) of the first frame the renderer missed.
     * Returns -1 when the cursor is outside the retained time ring.
     */
    qint64 lostSinceMs(quint64 rendererSeq, bool hasRendererSeq, const QString &rendererGeneration) const;

    /** Start a new sequence namespace (server restart). */
    void resetGeneration();

    /** `{eventSeq, eventSourceGeneration, eventChannelHealthy}` for /__pideck/heartbeat. */
    struct HeartbeatState {
        quint64 eventSeq = 0;
        QString generation;
        bool healthy = false;
    };
    HeartbeatState heartbeatState(bool hasRendererSeq, quint64 rendererSeq, const QString &rendererGeneration) const;

    // Sinks are plain callbacks (no Qt meta-object system): the backend does not
    // link moc, and the event hub is consumed by exactly one transport object.
    using FrameSink = std::function<void(quint64 seq, const QByteArray &frame, qint64 bytes)>;
    using ReplayGapSink = std::function<void(const QString &reason, qint64 lostSinceMs, bool hasLostSince)>;
    using OversizedSink = std::function<void(const QString &channel, qint64 bytes)>;
    using LargeFrameSink = std::function<void(const QString &channel, qint64 bytes, int suppressedSinceLast)>;

    void setFrameSink(FrameSink sink) { m_frameSink = std::move(sink); }
    void setReplayGapSink(ReplayGapSink sink) { m_replayGapSink = std::move(sink); }
    void setOversizedSink(OversizedSink sink) { m_oversizedSink = std::move(sink); }
    void setLargeFrameSink(LargeFrameSink sink) { m_largeFrameSink = std::move(sink); }

private:
    struct Record {
        quint64 seq = 0;
        QByteArray frame;
        qint64 bytes = 0;
    };

    quint64 appendPayload(const QByteArray &payload, const QString &channel, qint64 payloadBytes);
    void reportLargeFrame(const QString &channel, qint64 bytes);

    Limits m_limits;
    QString m_generation;
    quint64 m_eventSeq = 0;
    QList<Record> m_history;
    qint64 m_historyBytes = 0;
    QVector<qint64> m_eventTimes;
    qint64 m_lastLargeFrameLogAt = 0;
    int m_suppressedLargeFrames = 0;
    FrameSink m_frameSink;
    ReplayGapSink m_replayGapSink;
    OversizedSink m_oversizedSink;
    LargeFrameSink m_largeFrameSink;
};
