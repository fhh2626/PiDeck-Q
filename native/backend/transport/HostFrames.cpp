#include "HostFrames.h"

#include <QJsonDocument>

namespace host {

QByteArray encodeFrame(const QJsonObject &frame)
{
    const QByteArray payload = QJsonDocument(frame).toJson(QJsonDocument::Compact);
    QByteArray packet;
    packet.resize(4);
    const auto length = static_cast<quint32>(payload.size());
    packet[0] = char(length & 0xffU);
    packet[1] = char((length >> 8) & 0xffU);
    packet[2] = char((length >> 16) & 0xffU);
    packet[3] = char((length >> 24) & 0xffU);
    packet.append(payload);
    return packet;
}

void FrameDecoder::append(const QByteArray &chunk)
{
    m_buffer.append(chunk);
}

FrameDecoder::Result FrameDecoder::next(QByteArray *payload)
{
    if (m_buffer.size() < 4) return Result::NeedMore;
    const auto *header = reinterpret_cast<const unsigned char *>(m_buffer.constData());
    const quint32 length = quint32(header[0]) | (quint32(header[1]) << 8)
        | (quint32(header[2]) << 16) | (quint32(header[3]) << 24);
    if (length > kMaxFrameBytes) return Result::Oversized;
    if (m_buffer.size() < 4 + qsizetype(length)) return Result::NeedMore;
    if (payload) *payload = m_buffer.mid(4, qsizetype(length));
    m_buffer.remove(0, 4 + qsizetype(length));
    return Result::Frame;
}

void FrameDecoder::reset()
{
    m_buffer.clear();
}

} // namespace host
