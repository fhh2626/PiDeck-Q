#include "CatalogScanScheduler.h"

#include <QDateTime>
#include <QTimer>

#include <algorithm>
#include <utility>

namespace catalogscan {

Scheduler::Scheduler(QObject *parent) : QObject(parent) {}

Scheduler::~Scheduler()
{
    dispose();
}

void Scheduler::setCooldownMs(int milliseconds)
{
    m_cooldownMs = std::max(0, milliseconds);
}


void Scheduler::clearTimer(const QString &projectId)
{
    QTimer *timer = m_delayTimers.take(projectId);
    if (!timer) return;
    timer->stop();
    timer->deleteLater();
}

bool Scheduler::schedule(const QString &projectId, Task task)
{
    if (m_disposed || !task) return false;
    if (m_scanningProjects.contains(projectId)) {
        // Keep the *latest* task, not just the project: a later caller (the user expanding
        // the project) must not be replaced by the earlier refresh closure.
        m_pendingTasks.insert(projectId, std::move(task));
        return false;
    }
    m_scanningProjects.insert(projectId);
    const qint64 lastScanAt = m_lastScanAt.value(projectId, 0);
    const qint64 elapsed = QDateTime::currentMSecsSinceEpoch() - lastScanAt;
    const int waitMs = int(std::max<qint64>(0, m_cooldownMs - elapsed));
    auto *timer = new QTimer(this);
    timer->setSingleShot(true);
    m_delayTimers.insert(projectId, timer);
    connect(timer, &QTimer::timeout, this, [this, projectId] {
        clearTimer(projectId);
        auto task = m_delayedTasks.take(projectId);
        if (!task) {
            // Nothing to run (the task was replaced); release the slot so the project is
            // not stuck in "scanning" forever.
            m_scanningProjects.remove(projectId);
            return;
        }
        run(projectId, std::move(task));
    });
    // The delayed task lives next to the timer: a trigger arriving during the cooldown
    // merges into `pendingTasks`, and the oracle runs the delayed task first, then the
    // newer one.
    m_delayedTasks.insert(projectId, std::move(task));
    timer->start(waitMs);
    return true;
}

void Scheduler::run(const QString &projectId, Task task)
{
    if (m_disposed) return;
    // The slot is released by the scan's own completion callback, not by the dispatch: a
    // trigger arriving while the scan runs has to merge into `pendingTasks`.
    task([this, projectId] {
        if (m_disposed) return;
        m_lastScanAt.insert(projectId, QDateTime::currentMSecsSinceEpoch());
        m_scanningProjects.remove(projectId);
        // A trigger that arrived while scanning gets exactly one follow-up run, and that
        // run is bound by the same cooldown.
        auto pending = m_pendingTasks.take(projectId);
        if (pending) schedule(projectId, std::move(pending));
    });
}

void Scheduler::dispose()
{
    if (m_disposed) return;
    m_disposed = true;
    for (auto iterator = m_delayTimers.begin(); iterator != m_delayTimers.end(); ++iterator) {
        QTimer *timer = iterator.value();
        timer->stop();
        timer->deleteLater();
    }
    m_delayTimers.clear();
    // A cancelled project must release its slot: otherwise a reused coordinator would only
    // ever merge that project into `pendingTasks` and never scan it again.
    m_scanningProjects.clear();
    m_delayedTasks.clear();
    m_pendingTasks.clear();
}

} // namespace catalogscan
