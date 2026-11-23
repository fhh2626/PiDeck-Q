#pragma once

#include <QList>
#include <QObject>
#include <QPointer>
#include <QProcess>
#include <QString>
#include <QStringList>

/**
 * Single owner of every child process the backend spawns (pi, terminals, git).
 *
 * The backend used to exit with std::_Exit, which skipped all destructors and left
 * pi and ConPTY children alive for the host to force-kill. Shutdown now runs through
 * this registry: stop accepting work, ask children to exit, wait a bounded grace
 * period, then kill. Processes are auto-untracked when they finish so a long-lived
 * backend does not accumulate dead entries.
 */
class ChildProcessRegistry : public QObject {

public:
    explicit ChildProcessRegistry(QObject *parent = nullptr);

    /** Track an already-configured QProcess. Ownership stays with the caller. */
    void track(QProcess *process, const QString &label);
    void untrack(QProcess *process);

    int count() const { return int(m_entries.size()); }
    /** Labels of the still-running tracked processes (diagnostics only). */
    QStringList runningLabels() const;

    /**
     * Terminate every tracked process, wait up to `graceMs` in total, then kill the
     * survivors. Returns the number of processes that had to be killed.
     *
     * `graceMs` is a budget for the whole set, not per process: the caller must keep it
     * inside the host's 1500 ms force-kill window.
     */
    int stopAll(int graceMs = 3'000);

private:
    struct Entry {
        QPointer<QProcess> process;
        QString label;
    };
    QList<Entry> m_entries;
};
