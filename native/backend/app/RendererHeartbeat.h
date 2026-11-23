#pragma once

#include <QtGlobal>

#include <functional>

/**
 * Renderer heartbeat watchdog and stalled-cursor recovery policy.
 *
 * Port of src/native-node/transport/nativeHeartbeatWatchdog.ts and
 * nativeHeartbeatRecovery.ts. Two independent rules, deliberately separated:
 *
 *  1. The watchdog reloads the page only when heartbeats stop for several complete
 *     windows. A silent page has stopped running its own timer, so pushing state would
 *     never be read — a reload is the only recovery.
 *  2. A *stalled event cursor* never reloads the page. It re-pushes full renderer state
 *     instead, with exponential backoff, because a re-push that fires every window feeds
 *     the stall it is trying to repair.
 *
 * The policy functions are pure so the thresholds can be reasoned about (and exercised
 * through the backend's env overrides) without waiting 45 seconds.
 */
namespace rendererheartbeat {

constexpr int kDefaultWindowMs = 15'000;
constexpr int kDefaultMissedWindowsBeforeReload = 3;
/** Upper bound for the resync backoff, expressed in heartbeat windows. */
constexpr int kMaxResyncBackoffHeartbeats = 20;

/**
 * A single tick gap at least as long as the full reload window means the whole backend
 * was suspended (lid closed, machine asleep), so the elapsed time is not the page's fault.
 */
bool shouldResetAfterSuspend(qint64 tickGapMs,
                             qint64 suspendGapMs = qint64(kDefaultWindowMs) * kDefaultMissedWindowsBeforeReload);

/** True once `elapsedMs` covers `missedWindowsBeforeReload` complete windows. */
bool shouldReloadAfterMissed(qint64 elapsedMs, int windowMs = kDefaultWindowMs,
                             int missedWindowsBeforeReload = kDefaultMissedWindowsBeforeReload);

/** Cursor-based recovery state for one renderer page. */
struct RecoveryState {
    int consecutiveStalled = 0;
    bool hasRendererSeq = false;
    qint64 lastRendererSeq = 0;
    int resyncAttempts = 0;
    int nextResyncAtStalled = kDefaultMissedWindowsBeforeReload;
};

struct RecoveryResult {
    RecoveryState state;
    /** Re-push full renderer state; never a page reload. */
    bool shouldResync = false;
};

/**
 * Advance the stalled-cursor state machine by one heartbeat.
 *
 * Only unhealthy heartbeats whose renderer cursor did not advance count as stalled: a
 * stale server snapshot during active SSE delivery must not escalate while the renderer
 * is demonstrably consuming newer events.
 */
RecoveryResult advanceRecovery(const RecoveryState &previous, bool hasRendererSeq, qint64 rendererSeq,
                               bool eventChannelHealthy,
                               int resyncAfter = kDefaultMissedWindowsBeforeReload);

/**
 * Periodic watchdog. `reload` receives a completion callback so the grace period starts
 * when the reload settles, not when it is requested (otherwise a slow reload immediately
 * re-triggers).
 */
class Watchdog {
public:
    struct Deps {
        std::function<qint64()> now;
        /** False while the window is hidden/destroyed: a tray page is allowed to be idle. */
        std::function<bool()> shouldWatch;
        std::function<void(std::function<void()>)> reload;
        std::function<void()> onReload;
        /** Heartbeat window; overridable so the recovery path is testable in seconds. */
        int windowMs = kDefaultWindowMs;
        int missedWindowsBeforeReload = kDefaultMissedWindowsBeforeReload;
    };

    explicit Watchdog(Deps deps);

    /** Record a heartbeat (or a window becoming visible). */
    void touch();
    /** Called on every tick; reloads at most once per grace period. */
    void tick();
    /** Give the page a fresh grace period (new page load). */
    void reset();

private:
    void performReload();

    Deps m_deps;
    qint64 m_lastHeartbeatAt = 0;
    qint64 m_lastTickAt = 0;
    bool m_reloadInFlight = false;
};

} // namespace rendererheartbeat
