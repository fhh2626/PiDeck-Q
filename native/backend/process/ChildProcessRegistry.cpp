#include "ChildProcessRegistry.h"

#include <QElapsedTimer>

namespace {

/**
 * Total budget for reaping processes that ignored `terminate()`.
 *
 * Part of the host's 1500 ms force-kill window (native/src/NodeProcessController.cpp), so
 * it is a fixed small number rather than a per-process wait.
 */
constexpr int kKillBudgetMs = 150;

} // namespace

ChildProcessRegistry::ChildProcessRegistry(QObject *parent)
    : QObject(parent)
{
}

void ChildProcessRegistry::track(QProcess *process, const QString &label)
{
    if (!process) return;
    for (const Entry &entry : std::as_const(m_entries)) {
        if (entry.process == process) return;
    }
    m_entries.append(Entry{QPointer<QProcess>(process), label});
    connect(process, &QProcess::finished, this, [this, process](int, QProcess::ExitStatus) {
        untrack(process);
    });
    connect(process, &QObject::destroyed, this, [this, process] { untrack(process); });
}

void ChildProcessRegistry::untrack(QProcess *process)
{
    for (int index = m_entries.size() - 1; index >= 0; --index) {
        if (m_entries.at(index).process == process || m_entries.at(index).process.isNull()) {
            m_entries.removeAt(index);
        }
    }
}

QStringList ChildProcessRegistry::runningLabels() const
{
    QStringList labels;
    for (const Entry &entry : m_entries) {
        if (entry.process && entry.process->state() != QProcess::NotRunning) labels.append(entry.label);
    }
    return labels;
}

int ChildProcessRegistry::stopAll(int graceMs)
{
    QList<QPointer<QProcess>> processes;
    for (const Entry &entry : std::as_const(m_entries)) {
        if (entry.process && entry.process->state() != QProcess::NotRunning) processes.append(entry.process);
    }
    if (processes.isEmpty()) {
        m_entries.clear();
        return 0;
    }
    for (const auto &process : std::as_const(processes)) {
        if (process) process->terminate();
    }
    QElapsedTimer clock;
    clock.start();
    // The grace period is a budget for the whole registry, not per process. `terminate()`
    // is a no-op on Windows for console children (pi, git, node) because they own no
    // top-level window, so a per-process wait would multiply the budget by the child count
    // and blow the host's 1500 ms force-kill window, losing the window bounds the backend
    // persists during shutdown.
    for (;;) {
        QPointer<QProcess> pending;
        for (const auto &process : std::as_const(processes)) {
            if (process && process->state() != QProcess::NotRunning) {
                pending = process;
                break;
            }
        }
        if (!pending) break;
        const int remaining = graceMs - int(clock.elapsed());
        if (remaining <= 0) break;
        pending->waitForFinished(remaining);
    }

    QList<QPointer<QProcess>> survivors;
    for (const auto &process : std::as_const(processes)) {
        if (process && process->state() != QProcess::NotRunning) survivors.append(process);
    }
    if (survivors.isEmpty()) {
        m_entries.clear();
        return 0;
    }
    for (const auto &process : std::as_const(survivors)) process->kill();
    // Kill is not instantaneous either; give the whole set one bounded window to be reaped
    // so the ACK is not sent while the host is still hunting the job object.
    QElapsedTimer killClock;
    killClock.start();
    for (const auto &process : std::as_const(survivors)) {
        if (!process) continue;
        const int remaining = kKillBudgetMs - int(killClock.elapsed());
        if (process->state() == QProcess::NotRunning) continue;
        process->waitForFinished(qMax(0, remaining));
    }
    m_entries.clear();
    return int(survivors.size());
}
