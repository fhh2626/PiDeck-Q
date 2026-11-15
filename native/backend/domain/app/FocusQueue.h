#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QObject>
#include <QString>

#include <functional>

/**
 * Pending focus target: pull, live push and stale-ACK guard.
 *
 * Port of `NativeBackendHost.pendingFocusTarget` (src/native-node/host/NativeBackendHost.ts).
 * A click on a system notification or a secondary launch has to move the renderer to a
 * session, but neither SSE delivery nor the page's own mount order can be trusted:
 *
 *  - the target is *kept* until the renderer acknowledges the exact id it handled, so a
 *    push lost during EventSource setup is still pullable;
 *  - every request gets a fresh id, so a late ACK for an older target can never clear a
 *    newer one;
 *  - `window.ready` re-pushes the pending target without consuming it, because the page
 *    may not have subscribed yet when the window appears.
 *
 * Delivery is one argument: `{id, sessionId}` on `app:focus-session-target`.
 */
namespace appfocus {

class Queue : public QObject {
public:
    struct Deps {
        /** Fire-and-forget host call (`window.show` / `window.focus`). */
        std::function<void(const QString &method)> requestWindow;
        /** Renderer event broadcast (`app:focus-session-target`). */
        std::function<void(const QString &channel, const QJsonArray &args)> broadcast;
        /** Fresh delivery identity (uuid) for one target. */
        std::function<QString()> newId;
    };

    explicit Queue(Deps deps, QObject *parent = nullptr);

    /**
     * Focus the window and queue `sessionId` for the renderer.
     *
     * `showWindow=false` is the secondary-launch path: the caller already restored the
     * window, so only the target is handed over. Returns the live-window flag so the
     * caller can log a skipped jump exactly like the oracle.
     */
    bool focusSession(const QString &sessionId, bool showWindow = true);

    /** Queue a target without touching the window (`application.focusTarget` event). */
    void setPendingTarget(const QString &sessionId);

    /** The pending target, or a null value. Reading never consumes it. */
    QJsonValue peek() const;

    /** Clear only the target whose id the renderer actually handled. */
    void acknowledge(const QString &id);

    /** A new page: re-push the pending target, never consume it. */
    void onWindowReady();

    bool windowLive() const;
    void setWindowLive(bool live);

private:
    void push(const QJsonObject &target) const;

    Deps m_deps;
    QJsonObject m_pending;
    bool m_hasPending = false;
    bool m_windowLive = false;
};

} // namespace appfocus
