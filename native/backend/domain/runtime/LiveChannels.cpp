#include "LiveChannels.h"

#include "AgentSession.h"
#include "RuntimeTypes.h"

#include <QJsonObject>
#include <QJsonValue>
#include <QTimer>

namespace agentruntime {
namespace {

/** Oracle `LatestByKeyEmitter` window / `MESSAGE_FLUSH_INTERVAL_MS`. */
constexpr int kCoalesceMs = 50;
/** Full-text resync every N pushes, so a dropped delta cannot desync the live row. */
constexpr int kFullResyncPushes = 50;


QTimer *makeTimer(QObject *context, int windowMs)
{
    auto *timer = new QTimer(context);
    timer->setSingleShot(true);
    timer->setTimerType(Qt::PreciseTimer);
    timer->setInterval(windowMs);
    return timer;
}

void applyIncremental(QJsonObject *payload, const QString &text, const QString &lastSent,
                      int pushCount)
{
    if (!text.startsWith(lastSent) || pushCount >= kFullResyncPushes) {
        payload->insert(QStringLiteral("text"), text);
    } else {
        payload->insert(QStringLiteral("delta"), text.mid(lastSent.size()));
    }
}

} // namespace

LiveChannels::LiveChannels(AgentSession *session) : m_session(session)
{
    if (!m_session) return;
    QObject *context = m_session->timerContext();
    m_thinkingTimer = makeTimer(context, kCoalesceMs);
    QObject::connect(m_thinkingTimer, &QTimer::timeout, context, [this]() {
        if (!m_thinkingActive) return;
        emitThinkingFrame(m_pendingThinking, false);
    });
    m_textTimer = makeTimer(context, kCoalesceMs);
    QObject::connect(m_textTimer, &QTimer::timeout, context, [this]() {
        if (!m_textActive) return;
        emitTextFrame(m_pendingText, false);
    });
    m_messageTimer = makeTimer(context, kCoalesceMs);
    QObject::connect(m_messageTimer, &QTimer::timeout, context, [this]() { flushMessagesNow(); });
}

LiveChannels::~LiveChannels()
{
    if (m_thinkingTimer) m_thinkingTimer->stop();
    if (m_textTimer) m_textTimer->stop();
    if (m_messageTimer) m_messageTimer->stop();
}

void LiveChannels::startThinkingTimer()
{
    if (!m_thinkingTimer || m_thinkingTimer->isActive()) return;
    m_thinkingTimer->start();
}

void LiveChannels::startTextTimer()
{
    if (!m_textTimer || m_textTimer->isActive()) return;
    m_textTimer->start();
}

void LiveChannels::startMessageTimer()
{
    if (!m_messageTimer || m_messageTimer->isActive()) return;
    m_messageTimer->start();
}

void LiveChannels::pushThinking(const QString &text)
{
    m_pendingThinking = text;
    m_thinkingActive = true;
    startThinkingTimer();
}

QString LiveChannels::appendText(const QString &delta)
{
    m_pendingText += delta;
    return m_pendingText;
}

QString LiveChannels::replaceText(const QString &text)
{
    m_pendingText = text;
    return m_pendingText;
}

void LiveChannels::pushText(const QString &text)
{
    m_pendingText = text;
    m_textActive = true;
    startTextTimer();
}

void LiveChannels::emitThinkingFrame(const QString &text, bool done)
{
    if (!m_session) return;
    const Transcript &transcript = m_session->transcript();
    if (!transcript.hasThinkingSegment()) return;
    QJsonObject payload{
        {QStringLiteral("agentId"), m_session->tab().id},
        {QStringLiteral("id"), transcript.thinkingId()},
        {QStringLiteral("startedAt"), static_cast<double>(transcript.thinkingStartedAt())},
        {QStringLiteral("endedAt"), static_cast<double>(transcript.thinkingEndedAt())},
        {QStringLiteral("done"), done},
    };
    if (done) {
        // `finishThinkingChannel` always carries the full text; the renderer releases the
        // live bubble only after the History row is visible.
        payload.insert(QStringLiteral("text"), text);
    } else {
        const int pushCount = m_thinkingPushCount + 1;
        applyIncremental(&payload, text, m_lastSentThinking, pushCount);
        m_lastSentThinking = text;
        m_thinkingPushCount = pushCount >= kFullResyncPushes ? 0 : pushCount;
    }
    m_session->emitChannel(QStringLiteral("agents:thinking"), payload);
}

void LiveChannels::emitTextFrame(const QString &text, bool done)
{
    if (!m_session) return;
    QJsonObject payload{
        {QStringLiteral("agentId"), m_session->tab().id},
    };
    const QString messageId = m_session->transcript().activeAssistantId();
    if (!messageId.isEmpty()) payload.insert(QStringLiteral("messageId"), messageId);
    const int pushCount = m_textPushCount + 1;
    applyIncremental(&payload, text, m_lastSentText, pushCount);
    payload.insert(QStringLiteral("done"), done);
    m_lastSentText = text;
    m_textPushCount = pushCount >= kFullResyncPushes ? 0 : pushCount;
    m_session->emitChannel(QStringLiteral("agents:text-stream"), payload);
    if (done) {
        // Oracle deletes both maps on the terminal frame: the next reply starts with a
        // full-text frame instead of a delta against the previous answer.
        m_lastSentText.clear();
        m_textPushCount = 0;
    }
}

void LiveChannels::thinkingEnded()
{
    if (!m_session) return;
    Transcript &transcript = m_session->transcript();
    if (!transcript.hasThinkingSegment()) return;
    // Already ended: never re-flush/re-emit per body delta (oracle
    // `markThinkingSegmentEnded` early-returns on `endedAt > 0`).
    if (transcript.thinkingEndedAt() != 0) return;
    transcript.endThinking();
    if (m_thinkingTimer) m_thinkingTimer->stop();
    // Phase terminal state: publish the latest text with endedAt set, still `done=false`
    // (the oracle's `markThinkingSegmentEnded`). `done=true` belongs to message_end.
    emitThinkingFrame(m_pendingThinking, false);
}

void LiveChannels::finishThinking()
{
    if (m_thinkingTimer) m_thinkingTimer->stop();
    if (!m_thinkingActive) {
        // Pi can provide all the reasoning in its terminal snapshot. The clock
        // opened by message_start still needs closing, even without live deltas.
        if (m_session) m_session->transcript().clearThinking();
        return;
    }
    const QString text = m_pendingThinking;
    m_thinkingActive = false;
    emitThinkingFrame(text, true);
    m_lastSentThinking.clear();
    m_thinkingPushCount = 0;
    m_pendingThinking.clear();
    if (m_session) m_session->transcript().clearThinking();
}

void LiveChannels::finishText()
{
    if (!m_textActive) return;
    const bool pendingFrame = m_textTimer && m_textTimer->isActive();
    if (m_textTimer) m_textTimer->stop();
    // Same order as the oracle: flush a coalesced frame (only when one is pending),
    // then send the terminal one.
    if (pendingFrame) emitTextFrame(m_pendingText, false);
    m_textActive = false;
    emitTextFrame(m_pendingText, true);
    m_pendingText.clear();
}

void LiveChannels::scheduleMessages(bool completedRow)
{
    m_completedRowPending |= completedRow;
    startMessageTimer();
}

void LiveChannels::flushPendingCompletedRows()
{
    if (m_completedRowPending) flushMessagesNow();
}

void LiveChannels::clearAssistantBoundary()
{
    m_lastAssistantUpdateMessages = {};
    m_lastAssistantUpdateFileVersion.clear();
}

void LiveChannels::publishMessages()
{
    m_completedRowPending = false;
    if (m_messageTimer) m_messageTimer->stop();
    m_session->emitChannel(QStringLiteral("agents:message"),
                           m_session->transcript().flushPayload(m_session->fileVersion()));
}

void LiveChannels::flushMessagesNow()
{
    clearAssistantBoundary();
    if (!m_session) return;
    m_session->refreshFileVersion();
    publishMessages();
}

void LiveChannels::flushAssistantBoundary(AssistantBoundary boundary)
{
    if (!m_session) return;
    m_session->refreshFileVersion();
    const auto &messages = m_session->transcript().messages();
    if (boundary == AssistantBoundary::End) {
        // A file write or queued tool result still needs a fresh snapshot, even
        // when the last assistant row's text hasn't changed.
        const bool alreadyPublished = !m_lastAssistantUpdateMessages.isEmpty()
            && (!m_messageTimer || !m_messageTimer->isActive())
            && m_lastAssistantUpdateFileVersion == m_session->fileVersion()
            && m_lastAssistantUpdateMessages == messages;
        clearAssistantBoundary();
        if (alreadyPublished) return;
    } else {
        m_lastAssistantUpdateMessages = messages;
        m_lastAssistantUpdateFileVersion = m_session->fileVersion();
    }
    publishMessages();
}

void LiveChannels::settle()
{
    // Callers publish completed rows once before this cleanup, together with any trim.
    finishThinking();
    if (m_textTimer) m_textTimer->stop();
    if (m_messageTimer) m_messageTimer->stop();
    m_completedRowPending = false;
    clearAssistantBoundary();
    m_textActive = false;
    m_pendingText.clear();
    m_lastSentText.clear();
    m_textPushCount = 0;
}

void LiveChannels::reset()
{
    if (m_thinkingTimer) m_thinkingTimer->stop();
    if (m_textTimer) m_textTimer->stop();
    if (m_messageTimer) m_messageTimer->stop();
    m_completedRowPending = false;
    clearAssistantBoundary();
    m_textActive = false;
    m_thinkingActive = false;
    m_pendingText.clear();
    m_pendingThinking.clear();
    m_lastSentText.clear();
    m_lastSentThinking.clear();
    m_textPushCount = 0;
    m_thinkingPushCount = 0;
}

} // namespace agentruntime
