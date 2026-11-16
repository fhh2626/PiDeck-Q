#include "AgentTranscript.h"

#include "../sessions/PiTaskMessage.h"

#include <QCryptographicHash>
#include <QJsonDocument>
#include <QUuid>

#include <algorithm>

namespace agentruntime {
namespace {

bool isSummary(const QJsonObject &message)
{
    const QString type = message.value(QStringLiteral("meta")).toObject()
                             .value(QStringLiteral("type")).toString();
    return type == QLatin1String("compaction") || type == QLatin1String("branchSummary");
}

bool consumesFilePosition(const QJsonObject &message)
{
    const QJsonObject meta = message.value(QStringLiteral("meta")).toObject();
    // Missing-result placeholders share their assistant's source entry, and local
    // diagnostics have no row in the session file.
    if (meta.value(QStringLiteral("missingResult")).toBool(false)
        || meta.contains(QStringLiteral("sourceEntryId"))) return false;
    const QString role = message.value(QStringLiteral("role")).toString();
    return role == QLatin1String("user") || role == QLatin1String("assistant")
        || role == QLatin1String("tool") || pitask::isTodoTaskCard(QJsonValue(message));
}

} // namespace

int Transcript::firstFilePosition(const QJsonArray &messages) const
{
    for (const QJsonValue &value : messages) {
        const QJsonObject message = value.toObject();
        if (isSummary(message)) continue;
        const QJsonObject meta = message.value(QStringLiteral("meta")).toObject();
        const QString id = meta.value(QStringLiteral("entryId")).toString(
            meta.value(QStringLiteral("sourceEntryId")).toString());
        const auto position = m_fileEntryPositions.constFind(id);
        if (position != m_fileEntryPositions.constEnd()) return *position;
        const QJsonValue sequence = meta.value(QStringLiteral("_piDeckMsgSeq"));
        if (sequence.isDouble() && m_projectionHeadFilePos >= 0) {
            const auto rawPosition = m_projectedFilePositions.constFind(sequence.toInt());
            if (rawPosition != m_projectedFilePositions.constEnd()) {
                return m_projectionHeadFilePos + *rawPosition;
            }
        }
        if (consumesFilePosition(message)) return -1;
    }
    return -1;
}

void Transcript::configureHistory(const QStringList &fileEntryIds, int fallbackHead,
                                  bool preserveHistory, bool stickyHistory)
{
    m_fileEntryPositions.clear();
    for (int index = 0; index < fileEntryIds.size(); ++index) {
        m_fileEntryPositions.insert(fileEntryIds.at(index), index);
    }
    m_windowStart = 0;
    m_projectionHeadFilePos = fallbackHead;
    const QString projectionId = QUuid::createUuid().toString(QUuid::WithoutBraces);
    for (int index = 0; index < m_messages.size(); ++index) {
        QJsonObject message = m_messages.at(index).toObject();
        const QJsonObject meta = message.value(QStringLiteral("meta")).toObject();
        const QJsonValue sequence = meta.value(QStringLiteral("_piDeckMsgSeq"));
        if (!sequence.isDouble() || !meta.value(QStringLiteral("entryId")).toString().isEmpty()) continue;
        const QString fallbackId = QStringLiteral("%1-history-%2").arg(m_agentId).arg(sequence.toInt());
        if (message.value(QStringLiteral("id")).toString() != fallbackId) continue;
        const auto position = m_projectedFilePositions.constFind(sequence.toInt());
        // Raw indices restart after compaction. They cannot identify a row across
        // snapshots. Use the file cursor when known, otherwise an isolated snapshot
        // namespace. Neither form claims a persisted entryId for message mutations.
        QJsonObject identity = message;
        identity.remove(QStringLiteral("id"));
        identity.remove(QStringLiteral("agentId"));
        QJsonObject identityMeta = meta;
        identityMeta.remove(QStringLiteral("_piDeckMsgSeq"));
        identity.insert(QStringLiteral("meta"), identityMeta);
        // The cursor is only an estimate when RPC and file bodies differ. Bind it
        // to content too, so a shifted estimate never aliases an unrelated old row.
        const QString fingerprint = QString::fromLatin1(QCryptographicHash::hash(
            QJsonDocument(identity).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
        const QString id = fallbackHead >= 0 && position != m_projectedFilePositions.constEnd()
            ? QStringLiteral("%1-projection-file-%2-%3").arg(m_agentId).arg(fallbackHead + *position).arg(fingerprint)
            : QStringLiteral("%1-projection-%2-%3").arg(m_agentId, projectionId).arg(sequence.toInt());
        message.insert(QStringLiteral("id"), id);
        m_messages.replace(index, message);
    }
    const int position = firstFilePosition(m_messages);
    m_windowStartFilePos = position >= 0 ? position : fallbackHead;
    m_preserveHistory = preserveHistory;
    m_stickyHistory = preserveHistory && stickyHistory;
    if (!preserveHistory) m_pendingSlideOut = QJsonArray();
}

void Transcript::noteHistoryTrim(int start)
{
    int nextPosition = m_windowStartFilePos;
    for (int index = 0; index < start; ++index) {
        const QJsonObject message = m_messages.at(index).toObject();
        if (isSummary(message)) continue;
        ++m_windowStart;
        m_pendingSlideOut.append(message);
        const QJsonObject meta = message.value(QStringLiteral("meta")).toObject();
        const QJsonValue sequence = meta.value(QStringLiteral("_piDeckMsgSeq"));
        if (sequence.isDouble() && m_projectionHeadFilePos >= 0) {
            const auto position = m_projectedFilePositions.constFind(sequence.toInt());
            if (position != m_projectedFilePositions.constEnd()) {
                // Several display rows can share one assistant source slot. Empty
                // raw rows can also occupy slots without creating any display row.
                nextPosition = std::max(nextPosition, m_projectionHeadFilePos + *position + 1);
                continue;
            }
        }
        if (!consumesFilePosition(message)) continue;
        if (nextPosition >= 0) {
            if (m_projectionHeadFilePos >= 0) {
                nextPosition = std::max(nextPosition, m_projectionHeadFilePos + m_projectedFileCount);
            }
            ++nextPosition;
        }
    }
    m_windowStartFilePos = nextPosition;
}

void Transcript::messageFlushDelivered()
{
    m_preserveHistory = true;
    m_stickyHistory = false;
    m_pendingSlideOut = QJsonArray();
}

} // namespace agentruntime
