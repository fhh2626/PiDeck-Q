#include "app/FocusQueue.h"

#include <utility>

namespace appfocus {

Queue::Queue(Deps deps, QObject *parent)
    : QObject(parent), m_deps(std::move(deps))
{
}

bool Queue::focusSession(const QString &sessionId, bool showWindow)
{
    if (showWindow) {
        if (m_deps.requestWindow) {
            // Restoring a hidden-to-tray window must happen even when the target cannot
            // be resolved: the user asked for the app, not for a specific session.
            m_deps.requestWindow(QStringLiteral("window.show"));
            m_deps.requestWindow(QStringLiteral("window.focus"));
        }
    }
    if (!sessionId.isEmpty()) {
        // A pull-safe copy is kept even for a live window: the page's EventSource may
        // still be connecting, so the pushed frame can arrive before anyone listens.
        setPendingTarget(sessionId);
        if (m_windowLive) push(m_pending);
    }
    return m_windowLive;
}

void Queue::setPendingTarget(const QString &sessionId)
{
    if (sessionId.isEmpty()) return;
    m_pending = QJsonObject{
        {QStringLiteral("id"), m_deps.newId ? m_deps.newId() : QString()},
        {QStringLiteral("sessionId"), sessionId},
    };
    m_hasPending = true;
}

QJsonValue Queue::peek() const
{
    return m_hasPending ? QJsonValue(m_pending) : QJsonValue(QJsonValue::Null);
}

void Queue::acknowledge(const QString &id)
{
    if (!m_hasPending || id.isEmpty()) return;
    // Only the id the renderer reports as handled may clear the queue; an older ACK
    // arriving late must not drop a target the user has not seen yet.
    if (m_pending.value(QStringLiteral("id")).toString() != id) return;
    m_pending = QJsonObject{};
    m_hasPending = false;
}

void Queue::onWindowReady()
{
    // `window.ready` can precede the page's subscription, so this is a best-effort
    // re-push; the renderer's pull RPC stays the reliable take-and-clear path.
    if (m_hasPending) push(m_pending);
}

bool Queue::windowLive() const
{
    return m_windowLive;
}

void Queue::setWindowLive(bool live)
{
    m_windowLive = live;
}

void Queue::push(const QJsonObject &target) const
{
    if (!m_deps.broadcast) return;
    m_deps.broadcast(QStringLiteral("app:focus-session-target"), QJsonArray{target});
}

} // namespace appfocus
