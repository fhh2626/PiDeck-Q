#pragma once

#include <QHash>
#include <QObject>
#include <QString>
#include <QSet>

#include <functional>

class QTimer;

/**
 * Background project-catalog scan coordination.
 *
 * Port of src/main/sessions/CatalogScanScope.ts + BackgroundScanCoordinator.ts.
 *
 * Expanding a project used to synchronously scan every JSONL of that project (hundreds of
 * files plus summary parsing) on each `sessions:catalog-list`, and the sidebar's 3 s poll
 * repeated it forever. The channel now returns the catalog cache immediately and moves the
 * scan here:
 *
 *  - a trigger while a scan is running is merged into one pending re-run (never two scans
 *    of the same project at once);
 *  - a trigger inside the cooldown window waits for the window to end (the poll must not
 *    produce back-to-back scans);
 *  - the slot is claimed *before* the delay, so the waiting window cannot be scheduled
 *    twice.
 *
 * Everything is owned per backend instance: `dispose()` releases the delay timers, the
 * pending tasks and the scanned-project history, so a rebuilt backend starts cold instead
 * of inheriting a half-open slot.
 */
namespace catalogscan {

class Scheduler : public QObject {
public:
    explicit Scheduler(QObject *parent = nullptr);
    ~Scheduler() override;

    /** Cooldown between two scans of the same project (oracle: 5000 ms). */
    void setCooldownMs(int milliseconds);
    int cooldownMs() const { return m_cooldownMs; }


    /**
     * A scan: `start(done)` dispatches the work and must call `done` exactly once,
     * on the main thread, when the scan finished. The slot stays claimed until then, so
     * a trigger arriving mid-scan merges instead of starting a second scan.
     */
    using Task = std::function<void(std::function<void()> done)>;

    /**
     * Schedule one scan.
     * @returns true when this call will run `task` (now or after the cooldown),
     *          false when a scan is already running and the task was merged as pending.
     */
    bool schedule(const QString &projectId, Task task);

    /** Cancel delayed scans and drop every queued task. Idempotent. */
    void dispose();
    bool disposed() const { return m_disposed; }

private:
    void run(const QString &projectId, Task task);
    void clearTimer(const QString &projectId);

    int m_cooldownMs = 5'000;
    QSet<QString> m_scanningProjects;
    /** Task waiting for the cooldown to expire (the timer's own closure). */
    QHash<QString, Task> m_delayedTasks;
    /** Task merged while the slot was held (the timer's task still runs first). */
    QHash<QString, Task> m_pendingTasks;
    QHash<QString, qint64> m_lastScanAt;
    QHash<QString, QTimer *> m_delayTimers;
    bool m_disposed = false;
};

} // namespace catalogscan
