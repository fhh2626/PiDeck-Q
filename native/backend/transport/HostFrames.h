#pragma once

#include <QByteArray>
#include <QJsonObject>

/**
 * Length-prefixed JSON framing shared by the Qt host (native/src/HostRpcServer.cpp)
 * and the C++ backend. The wire format is fixed by the host: a 4-byte little-endian
 * payload length followed by a compact JSON object. It is the ONLY host<->backend
 * channel, so both directions must agree on the caps below.
 */
namespace host {

/** Mirrors HostRpcServer.cpp kMaxFrameBytes. */
constexpr quint32 kMaxFrameBytes = 32U * 1024U * 1024U;
/** Mirrors HostRpcServer.cpp kMaxPendingWriteBytes (write backpressure budget). */
constexpr qint64 kMaxPendingWriteBytes = 8LL * 1024LL * 1024LL;
/** The host closes an unauthenticated connection after this long. */
constexpr int kHelloTimeoutMs = 5'000;
/**
 * Default per-request deadline. The Node oracle's HostBridge.request() has no
 * timeout; the C++ backend adds one so a wedged host cannot pin a caller forever.
 * Callers may override per request.
 */
constexpr int kDefaultRequestTimeoutMs = 30'000;

/** Encode one frame (4-byte LE length prefix + compact JSON payload). */
QByteArray encodeFrame(const QJsonObject &frame);

/**
 * Incremental decoder for the host framing.
 *
 * Frames arrive split across TCP reads and several frames may arrive in one read,
 * so decoding has to be stateful. An oversized declared length is reported as
 * Oversized instead of being buffered: the host caps frames at 32 MiB and a larger
 * prefix means the stream is corrupt.
 */
class FrameDecoder {
public:
    enum class Result { Frame, NeedMore, Oversized };

    void append(const QByteArray &chunk);
    /** Consume the next complete payload. Returns NeedMore when the buffer is short. */
    Result next(QByteArray *payload);
    void reset();
    qsizetype bufferedBytes() const { return m_buffer.size(); }

private:
    QByteArray m_buffer;
};

} // namespace host
