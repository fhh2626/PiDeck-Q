#include "AgentTranscript.h"

#include "../sessions/PiTaskMessage.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QUuid>

namespace agentruntime {
namespace {

QString newId()
{
    return QUuid::createUuid().toString(QUuid::WithoutBraces);
}

qint64 nowMs()
{
    return QDateTime::currentMSecsSinceEpoch();
}

/** Text blocks of a pi content array (thinking and tool_use excluded). */
QString extractText(const QJsonValue &content)
{
    if (!content.isArray()) return QString();
    QStringList parts;
    for (const QJsonValue &value : content.toArray()) {
        if (!value.isObject()) continue;
        const QJsonObject block = value.toObject();
        const QString type = block.value(QStringLiteral("type")).toString();
        if (type != QLatin1String("text")) continue;
        const QString text = block.value(QStringLiteral("text")).toString();
        if (!text.isEmpty()) parts.append(text);
    }
    return parts.join(QLatin1Char('\n'));
}

/** Delivery stripping: `meta.result` duplicates `meta.detailText` and is never read. */
QJsonArray stripToolResults(const QJsonArray &messages)
{
    QJsonArray out;
    for (const QJsonValue &value : messages) {
        if (!value.isObject()) {
            out.append(value);
            continue;
        }
        const QJsonObject message = value.toObject();
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("tool")) {
            out.append(value);
            continue;
        }
        QJsonObject meta = message.value(QStringLiteral("meta")).toObject();
        if (!meta.contains(QStringLiteral("result"))) {
            out.append(value);
            continue;
        }
        meta.remove(QStringLiteral("result"));
        QJsonObject copy = message;
        copy.insert(QStringLiteral("meta"), meta);
        out.append(copy);
    }
    return out;
}

bool isUserTurn(const QJsonObject &message)
{
    if (message.value(QStringLiteral("role")).toString() == QLatin1String("user")) return true;
    // The oracle trims with `isPiUserTurn`: a visible task card (system + todoTask meta)
    // is a user-initiated turn even though its role is not `user`.
    return pitask::isTodoTaskCard(QJsonValue(message));
}

bool isSummaryCard(const QJsonObject &message)
{
    const QString type = message.value(QStringLiteral("meta")).toObject()
                             .value(QStringLiteral("type")).toString();
    return type == QLatin1String("compaction") || type == QLatin1String("branchSummary");
}

} // namespace

void Transcript::configure(const QString &agentId, maincopy::Translator translate)
{
    m_agentId = agentId;
    m_translate = std::move(translate);
    reset();
}

void Transcript::reset()
{
    m_messages = QJsonArray();
    m_diagnosticIds.clear();
    m_activeAssistantId.clear();
    m_toolMessageIds.clear();
    m_thinkingId.clear();
    m_thinkingMessageId.clear();
    m_streamingThinking.clear();
    m_thinkingStartedAt = 0;
    m_thinkingEndedAt = 0;
    m_toolFullText.clear();
    m_toolFullTextOrder.clear();
    // Paired cleanup with `retryStatusMessageIds.delete(agentId)` in the oracle dispose path:
    // a reset transcript no longer holds the row, so the next retry must create a new id.
    m_retryStatusMessageId.clear();
}

void Transcript::rememberToolFullText(const QString &messageId, const QString &text)
{
    if (messageId.isEmpty() || text.isEmpty()) return;
    // Insertion order, oldest first: the oracle does not refresh order on read, so this is
    // a FIFO of the most recently *projected* truncated tool rows.
    if (!m_toolFullText.contains(messageId)) m_toolFullTextOrder.append(messageId);
    m_toolFullText.insert(messageId, text);
    while (m_toolFullTextOrder.size() > 200) {
        const QString oldest = m_toolFullTextOrder.takeFirst();
        m_toolFullText.remove(oldest);
    }
}

void Transcript::applyProjection(const QVector<QJsonValue> &rawMessages, const QStringList &entryIds,
                                 const QSet<QString> &toolResultIds)
{
    projector::Deps deps;
    deps.translate = m_translate;
    m_messages = projector::convert(m_agentId, rawMessages, entryIds, toolResultIds, deps);
}

void Transcript::preserveDiagnosticsSince(quint64 revision, const QJsonArray &previous)
{
    // A diagnostic belongs to its original turn, not whichever turn happens to be
    // last when the asynchronous projection arrives. Only durable entry IDs prove
    // that correspondence; matching text or ordinal positions can misattribute errors.
    QString anchor;
    for (int i = 0; i < previous.size(); ++i) {
        const QJsonObject row = previous.at(i).toObject();
        if (isUserTurn(row)) anchor = row.value(QStringLiteral("meta")).toObject()
                                          .value(QStringLiteral("entryId")).toString();
        const QString id = row.value(QStringLiteral("id")).toString();
        if (m_diagnosticIds.value(id, 0) <= revision) continue;
        if (anchor.isEmpty()) {
            bool laterTurn = false;
            for (int j = i + 1; j < previous.size(); ++j) {
                if (isUserTurn(previous.at(j).toObject())) { laterTurn = true; break; }
            }
            // With an intervening turn there is no safe way to identify the origin.
            if (!laterTurn) m_messages.append(row);
            continue;
        }
        int origin = -1;
        bool duplicate = false;
        for (int j = 0; j < m_messages.size(); ++j) {
            const QJsonObject candidate = m_messages.at(j).toObject();
            if (isUserTurn(candidate) && candidate.value(QStringLiteral("meta")).toObject()
                    .value(QStringLiteral("entryId")).toString() == anchor) {
                if (origin >= 0) duplicate = true;
                origin = j;
            }
        }
        // Missing/ambiguous anchors include turns removed by compaction or trimming.
        if (origin < 0 || duplicate) continue;
        int insertion = origin + 1;
        while (insertion < m_messages.size() && !isUserTurn(m_messages.at(insertion).toObject())) ++insertion;
        m_messages.insert(insertion, row);
    }
    pruneDiagnosticIds();
}

void Transcript::pruneDiagnosticIds()
{
    QSet<QString> retained;
    for (const QJsonValue &value : m_messages)
        retained.insert(value.toObject().value(QStringLiteral("id")).toString());
    for (auto it = m_diagnosticIds.begin(); it != m_diagnosticIds.end();) {
        if (!retained.contains(it.key())) it = m_diagnosticIds.erase(it);
        else ++it;
    }
}

int Transcript::indexOfId(const QString &id) const
{
    if (id.isEmpty()) return -1;
    for (int index = 0; index < m_messages.size(); ++index) {
        if (m_messages.at(index).toObject().value(QStringLiteral("id")).toString() == id) return index;
    }
    return -1;
}

int Transcript::findSamePiMessageIndex(const QString &role, const QString &text,
                                       const QString &toolCallId) const
{
    // Empty assistant skeletons have no content identity. Reusing an earlier empty
    // tool-use/thinking row writes the eventual answer before the tools, where the
    // renderer classifies it as foldable interim output. Only toolCallId can identify
    // an empty row (matching the Node oracle's findSamePiMessageIndex guard).
    if (toolCallId.isEmpty() && text.trimmed().isEmpty()) return -1;
    for (int index = m_messages.size() - 1; index >= 0; --index) {
        const QJsonObject message = m_messages.at(index).toObject();
        if (message.value(QStringLiteral("role")).toString() != role) continue;
        if (!toolCallId.isEmpty()) {
            const QJsonObject meta = message.value(QStringLiteral("meta")).toObject();
            if (meta.value(QStringLiteral("toolCallId")).toString() == toolCallId) return index;
            continue;
        }
        if (message.value(QStringLiteral("text")).toString() == text) return index;
    }
    return -1;
}

QString Transcript::upsertAssistant(const QJsonObject &partialMessage, const QString &fallbackDelta,
                                    bool allowEmpty)
{
    if (m_activeAssistantId.isEmpty()) m_activeAssistantId = newId();
    const QJsonValue content = partialMessage.value(QStringLiteral("content"));
    const bool hasSnapshot = partialMessage.contains(QStringLiteral("content"));
    QString text = hasSnapshot ? extractText(content) : QString();
    if (text.isEmpty() && !hasSnapshot) text = fallbackDelta;

    int index = indexOfId(m_activeAssistantId);
    // A reload can replace runtime rows with projected ones; rebinding by content keeps
    // a single row instead of appending a duplicate for the same pi message.
    if (index < 0) {
        const int rebind = findSamePiMessageIndex(QStringLiteral("assistant"), text);
        if (rebind >= 0) {
            index = rebind;
            m_activeAssistantId = m_messages.at(rebind).toObject().value(QStringLiteral("id")).toString();
        }
    }
    const QString stopReason = partialMessage.value(QStringLiteral("stopReason")).toString();
    if (index >= 0) {
        QJsonObject message = m_messages.at(index).toObject();
        if (!text.isEmpty() || allowEmpty) message.insert(QStringLiteral("text"), text);
        message.insert(QStringLiteral("timestamp"), static_cast<double>(nowMs()));
        if (!stopReason.isEmpty() && stopReason != QLatin1String("pending")) {
            message.insert(QStringLiteral("stopReason"), stopReason);
        }
        m_messages.replace(index, message);
        return m_activeAssistantId;
    }
    if (text.isEmpty() && !allowEmpty) return m_activeAssistantId;

    QJsonObject message{
        {QStringLiteral("id"), m_activeAssistantId},
        {QStringLiteral("agentId"), m_agentId},
        {QStringLiteral("role"), QStringLiteral("assistant")},
        {QStringLiteral("text"), text},
        {QStringLiteral("timestamp"), static_cast<double>(nowMs())},
    };
    if (!stopReason.isEmpty() && stopReason != QLatin1String("pending")) {
        message.insert(QStringLiteral("stopReason"), stopReason);
    }
    m_messages.append(message);
    return m_activeAssistantId;
}

QString Transcript::upsertTool(const QJsonObject &event, const QString &status)
{
    const QString toolName = event.value(QStringLiteral("toolName")).toString(
        QStringLiteral("tool"));
    QString toolCallId = event.value(QStringLiteral("toolCallId")).toString();
    if (toolCallId.isEmpty()) {
        toolCallId = QStringLiteral("%1-%2").arg(toolName).arg(nowMs());
    }
    QString messageId = m_toolMessageIds.value(toolCallId);
    if (messageId.isEmpty()) {
        messageId = newId();
        m_toolMessageIds.insert(toolCallId, messageId);
    }
    int index = indexOfId(messageId);
    if (index < 0) {
        const int rebind = findSamePiMessageIndex(QStringLiteral("tool"), QString(), toolCallId);
        if (rebind >= 0) {
            index = rebind;
            messageId = m_messages.at(rebind).toObject().value(QStringLiteral("id")).toString();
            m_toolMessageIds.insert(toolCallId, messageId);
        }
    }
    const bool isError = status == QLatin1String("error")
        || event.value(QStringLiteral("isError")).toBool(false);
    QJsonObject existingMeta;
    qint64 startedAt = nowMs();
    QJsonValue args = event.value(QStringLiteral("args"));
    QJsonValue result = event.value(QStringLiteral("result"));
    if (result.isUndefined()) result = event.value(QStringLiteral("partialResult"));
    if (result.isUndefined()) result = event.value(QStringLiteral("output"));
    if (index >= 0) {
        const QJsonObject existing = m_messages.at(index).toObject();
        existingMeta = existing.value(QStringLiteral("meta")).toObject();
        const QJsonValue existingStarted = existingMeta.value(QStringLiteral("startedAt"));
        if (existingStarted.isDouble()) startedAt = qint64(existingStarted.toDouble());
        if (args.isUndefined()) args = existingMeta.value(QStringLiteral("args"));
        if (result.isUndefined()) result = existingMeta.value(QStringLiteral("result"));
    }

    const QString detailText = projector::toolDetail(toolName, args, result, isError, false,
                                                     m_translate);
    const QString deliveredDetail = projector::truncateForDetail(detailText, m_translate);
    const QString resultText = projector::toolResultText(result, m_translate);
    const QString icon = status == QLatin1String("running") ? QStringLiteral("▶")
        : isError                                         ? QStringLiteral("✗")
                                                          : QStringLiteral("✓");
    const QString text = QStringLiteral("%1 %2").arg(icon, toolName);

    QJsonObject meta{
        {QStringLiteral("status"), status},
        {QStringLiteral("toolName"), toolName},
        {QStringLiteral("toolCallId"), toolCallId},
        {QStringLiteral("startedAt"), static_cast<double>(startedAt)},
        {QStringLiteral("args"),
         args.isString() ? args.toString()
                         : projector::truncateForDetail(projector::safeJson(args), m_translate)},
        {QStringLiteral("result"),
         projector::truncateForDetail(resultText.isEmpty() ? projector::safeJson(result) : resultText,
                                      m_translate)},
        {QStringLiteral("isError"), isError},
        {QStringLiteral("detailText"), deliveredDetail},
    };
    if (status != QLatin1String("running")) {
        meta.insert(QStringLiteral("durationMs"),
                    static_cast<double>(std::max<qint64>(0, nowMs() - startedAt)));
    }
    if (detailText.size() > projector::kMaxToolResultChars) {
        meta.insert(QStringLiteral("truncated"), true);
        meta.insert(QStringLiteral("fullLength"), detailText.size());
        // Same value the oracle caches for "view full output": the untruncated result
        // text, or its JSON when the result carries no text.
        rememberToolFullText(messageId,
                             resultText.isEmpty() ? projector::safeJson(result) : resultText);
    }
    // Keep the projected identity fields (entryId / _piDeckMsgSeq) when rebinding.
    for (auto iterator = existingMeta.constBegin(); iterator != existingMeta.constEnd(); ++iterator) {
        if (!meta.contains(iterator.key())) meta.insert(iterator.key(), iterator.value());
    }

    if (index >= 0) {
        QJsonObject message = m_messages.at(index).toObject();
        message.insert(QStringLiteral("text"), text);
        message.insert(QStringLiteral("timestamp"), static_cast<double>(nowMs()));
        message.insert(QStringLiteral("meta"), meta);
        m_messages.replace(index, message);
        return messageId;
    }
    m_messages.append(QJsonObject{
        {QStringLiteral("id"), messageId},
        {QStringLiteral("agentId"), m_agentId},
        {QStringLiteral("role"), QStringLiteral("tool")},
        {QStringLiteral("text"), text},
        {QStringLiteral("timestamp"), static_cast<double>(nowMs())},
        {QStringLiteral("meta"), meta},
    });
    return messageId;
}

void Transcript::appendMessage(const QString &role, const QString &text, const QJsonObject &meta)
{
    QJsonObject message{
        {QStringLiteral("id"), newId()},
        {QStringLiteral("agentId"), m_agentId},
        {QStringLiteral("role"), role},
        {QStringLiteral("text"), text},
        {QStringLiteral("timestamp"), static_cast<double>(nowMs())},
    };
    if (!meta.isEmpty()) message.insert(QStringLiteral("meta"), meta);
    m_messages.append(message);
}

void Transcript::appendError(const QString &text)
{
    appendMessage(QStringLiteral("error"), text,
                  QJsonObject{{QStringLiteral("debugDetails"), text}});
}

void Transcript::appendDetailedError(const QString &i18nKey, const QString &fallback,
                                     const QJsonObject &params, const QString &debugDetails)
{
    QJsonObject meta{
        {QStringLiteral("i18nKey"), i18nKey},
        {QStringLiteral("i18nParams"), params},
    };
    // Oracle `addLocalizedMessage`: `...(options.debugDetails ? { debugDetails } : {})`, so a
    // failure without raw text has nothing to disclose behind the toast.
    if (!debugDetails.isEmpty()) meta.insert(QStringLiteral("debugDetails"), debugDetails);
    const QString text = m_translate(i18nKey, params);
    appendMessage(QStringLiteral("error"), text.isEmpty() ? fallback : text, meta);
    const QString id = m_messages.last().toObject().value(QStringLiteral("id")).toString();
    m_diagnosticIds.insert(id, ++m_diagnosticRevision);
}

QJsonObject Transcript::retryStatusMeta() const
{
    const int index = indexOfId(m_retryStatusMessageId);
    if (index < 0) return QJsonObject{};
    return m_messages.at(index).toObject().value(QStringLiteral("meta")).toObject();
}

void Transcript::appendLocalized(const QString &role, const QString &i18nKey,
                                 const QString &fallback, const QJsonObject &params)
{
    const QString text = m_translate(i18nKey, params);
    appendMessage(role, text.isEmpty() ? fallback : text,
                  QJsonObject{{QStringLiteral("i18nKey"), i18nKey},
                              {QStringLiteral("debugDetails"), fallback}});
}

void Transcript::upsertRetryStatus(const QString &status, const QString &i18nKey,
                                   const QJsonObject &params, const QJsonObject &meta)
{
    int index = indexOfId(m_retryStatusMessageId);
    QJsonObject row = index >= 0 ? m_messages.at(index).toObject() : QJsonObject();
    QJsonObject rowMeta = meta;
    // Exactly the oracle's field set (`upsertRetryStatusMessage` in AgentManager.ts): no
    // native-only marker is added, because `agents:message` rows must stay identical to the
    // ones the Node path produces and the row is already identifiable by `i18nKey`/`status`.
    rowMeta.insert(QStringLiteral("status"), status);
    rowMeta.insert(QStringLiteral("i18nKey"), i18nKey);
    rowMeta.insert(QStringLiteral("i18nParams"), params);
    // `m_translate` returns the key itself for a missing template; the caller keeps the
    // fallback empty on purpose, the table owns the sentence (both locales) just like the
    // oracle's main-process copy.
    const QString text = m_translate(i18nKey, params);
    if (index < 0) {
        m_retryStatusMessageId = newId();
        m_messages.append(QJsonObject{
            {QStringLiteral("id"), m_retryStatusMessageId},
            {QStringLiteral("agentId"), m_agentId},
            {QStringLiteral("role"), QStringLiteral("system")},
            {QStringLiteral("text"), text},
            {QStringLiteral("timestamp"), static_cast<double>(nowMs())},
            {QStringLiteral("meta"), rowMeta},
        });
        return;
    }
    row.insert(QStringLiteral("text"), text);
    row.insert(QStringLiteral("timestamp"), static_cast<double>(nowMs()));
    row.insert(QStringLiteral("meta"), rowMeta);
    m_messages.replace(index, row);
}

/**
 * Trim the runtime cache the way `contextTrimStartIndex` does.
 *
 * Difference from `turnTrimStartIndex`: when the cache holds fewer than `turns` user
 * turns the whole context still fits the budget, so nothing may be dropped. pi's
 * compaction keeps a segment that often *starts* with an assistant/tool row (and may be
 * preceded by a summary card); head-trimming at the first user row would delete the
 * answer the user just read and the cached summary of it. Only the no-user case keeps the
 * old tail-50 fallback, matching `Math.max(0, length - 50)`.
 */
bool Transcript::trimToTurns(int turns)
{
    ++m_trimRevision;
    if (turns <= 0 || m_messages.isEmpty()) return false;
    QVector<int> userIndices;
    for (int index = m_messages.size() - 1; index >= 0; --index) {
        if (isUserTurn(m_messages.at(index).toObject())) {
            userIndices.prepend(index);
            if (userIndices.size() >= turns) break;
        }
    }
    int start = 0;
    if (userIndices.isEmpty()) {
        // Oracle fallback is hard-coded to 50 rows regardless of the requested turn count.
        start = std::max(0, int(m_messages.size()) - 50);
    } else if (userIndices.size() < turns) {
        return false;
    } else {
        start = userIndices.first();
    }
    if (start <= 0) return false;
    QJsonArray trimmed;
    // Leading compaction/branch cards are not user turns but must stay visible.
    for (int index = 0; index < start; ++index) {
        const QJsonObject message = m_messages.at(index).toObject();
        if (isSummaryCard(message)) trimmed.append(message);
    }
    for (int index = start; index < m_messages.size(); ++index) trimmed.append(m_messages.at(index));
    if (trimmed.size() == m_messages.size()) return false;
    m_messages = trimmed;
    pruneDiagnosticIds();
    return true;
}

QJsonObject Transcript::flushPayload(const QString &fileVersion) const
{
    QJsonObject payload{
        {QStringLiteral("agentId"), m_agentId},
        {QStringLiteral("messages"), stripToolResults(m_messages)},
        {QStringLiteral("totalLength"), m_messages.size()},
    };
    if (!fileVersion.isEmpty()) payload.insert(QStringLiteral("fileVersion"), fileVersion);
    return payload;
}

void Transcript::beginThinking(const QString &messageId)
{
    if (!m_thinkingId.isEmpty()) return;
    m_thinkingMessageId = messageId;
    m_thinkingId = QStringLiteral("msg-thinking-%1").arg(messageId.isEmpty() ? newId() : messageId);
    m_thinkingStartedAt = nowMs();
    m_thinkingEndedAt = 0;
    m_streamingThinking.clear();
}

void Transcript::appendThinking(const QString &text)
{
    if (m_thinkingId.isEmpty()) return;
    m_streamingThinking = text;
    // `endedAt` deliberately stays 0 while the phase streams (oracle keeps
    // `segment.endedAt` unset until `markThinkingSegmentEnded`): the renderer derives
    // "still reasoning" from `endedAt <= 0`, so stamping it per delta made every live
    // frame look finished.
}

void Transcript::endThinking()
{
    if (m_thinkingId.isEmpty()) return;
    // Idempotent like `markThinkingSegmentEnded`: the phase end is published once, whether
    // the trigger was `thinking_end` or the first body `text_delta`.
    if (m_thinkingEndedAt != 0) return;
    m_thinkingEndedAt = nowMs();
}

void Transcript::clearThinking()
{
    m_thinkingId.clear();
    m_thinkingMessageId.clear();
    m_streamingThinking.clear();
    m_thinkingStartedAt = 0;
    m_thinkingEndedAt = 0;
}

void Transcript::finalizeThinking(const QJsonObject &partialMessage)
{
    const QString fromMessage = projector::messageThinking(partialMessage.value(QStringLiteral("content")));
    const QString nextThinking = !m_streamingThinking.isEmpty() ? m_streamingThinking : fromMessage;
    if (nextThinking.trimmed().isEmpty()) return;
    if (m_activeAssistantId.isEmpty()) m_activeAssistantId = newId();
    int index = indexOfId(m_activeAssistantId);
    if (index < 0) {
        const int rebind = findSamePiMessageIndex(
            QStringLiteral("assistant"), extractText(partialMessage.value(QStringLiteral("content"))));
        if (rebind >= 0) {
            index = rebind;
            m_activeAssistantId = m_messages.at(rebind).toObject().value(QStringLiteral("id")).toString();
        }
    }
    const qint64 startedAt = m_thinkingStartedAt > 0 ? m_thinkingStartedAt : nowMs();
    const qint64 endedAt = m_thinkingEndedAt > 0 ? m_thinkingEndedAt : nowMs();
    if (index >= 0) {
        QJsonObject message = m_messages.at(index).toObject();
        message.insert(QStringLiteral("thinking"), nextThinking);
        message.insert(QStringLiteral("thinkingStartedAt"), static_cast<double>(startedAt));
        message.insert(QStringLiteral("thinkingEndedAt"), static_cast<double>(endedAt));
        m_messages.replace(index, message);
        return;
    }
    m_messages.append(QJsonObject{
        {QStringLiteral("id"), m_activeAssistantId},
        {QStringLiteral("agentId"), m_agentId},
        {QStringLiteral("role"), QStringLiteral("assistant")},
        {QStringLiteral("text"), QString()},
        {QStringLiteral("timestamp"), static_cast<double>(nowMs())},
        {QStringLiteral("thinking"), nextThinking},
        {QStringLiteral("thinkingStartedAt"), static_cast<double>(startedAt)},
        {QStringLiteral("thinkingEndedAt"), static_cast<double>(endedAt)},
    });
}

QString Transcript::lastMessageRole() const
{
    if (m_messages.isEmpty()) return QString();
    return m_messages.last().toObject().value(QStringLiteral("role")).toString();
}


} // namespace agentruntime
