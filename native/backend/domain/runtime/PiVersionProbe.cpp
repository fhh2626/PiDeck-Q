#include "PiLaunch.h"

#include <QHash>
#include <QElapsedTimer>
#include <QPointer>
#include <QProcess>
#include <QRegularExpression>
#include <QTimer>

#include <memory>
#include <utility>

/**
 * pi version probing and CLI compatibility (declared in PiLaunch.h).
 *
 * Split out of `PiLaunch.cpp`, which owns launch/argv/env assembly and was already past the
 * file-size budget. Nothing here builds a command line: it only asks the *resolved* launch
 * for `--version` (with the npm-shim/WSL argv forms the launcher already prepared).
 * Runtime creation always probes again because an installed command can be replaced
 * in place. The last answer is retained only for synchronous launch identity snapshots.
 */
namespace pilaunch {
namespace {

/**
 * Synchronous snapshots share the answer for a resolved command. Session paths and
 * extensions do not identify an installation, so they must not fragment that snapshot.
 */
QString probeCacheKey(const Launch &launch)
{
    return launch.program + QLatin1Char('\n') + launch.nativeVersionArguments
        + QLatin1Char('\n') + launch.versionArguments.join(QLatin1Char('\x1f'));
}

QHash<QString, QString> &probeCache()
{
    static QHash<QString, QString> cache;
    return cache;
}

} // namespace

bool supportsProjectApprovalFlag(const QString &version)
{
    const QString value = version.trimmed();
    if (value.isEmpty()) return false;
    static const QRegularExpression pattern(QStringLiteral("^v?(\\d+)\\.(\\d+)"));
    const QRegularExpressionMatch match = pattern.match(value);
    if (!match.hasMatch()) return false;
    const int major = match.captured(1).toInt();
    const int minor = match.captured(2).toInt();
    return major > 0 || minor >= 79;
}

QString cachedVersion(const Launch &launch)
{
    const auto cached = probeCache().constFind(probeCacheKey(launch));
    return cached == probeCache().constEnd() ? QString() : *cached;
}

VersionProbeOwner::~VersionProbeOwner()
{
    cancel();
}

void VersionProbeOwner::cancel()
{
    if (m_cancelled) return;
    m_cancelled = true;
    const auto processes = findChildren<QProcess *>(QString(), Qt::FindDirectChildrenOnly);
    // Disconnect before killing: QProcess can emit finished synchronously while being
    // reaped, and shutdown must never re-enter a coordinator that is clearing its graph.
    for (QProcess *process : processes) {
        process->disconnect();
        if (process->state() != QProcess::NotRunning) process->kill();
    }
    QElapsedTimer budget;
    budget.start();
    for (QProcess *process : processes) {
        if (process->state() != QProcess::NotRunning) {
            process->waitForFinished(qMax(0, 150 - int(budget.elapsed())));
        }
        if (process->state() == QProcess::NotRunning) {
            delete process;
        } else {
            // Kill has already been sent. Do not let QProcess's destructor extend the
            // host's shutdown budget if the OS has not acknowledged it yet.
            process->setParent(nullptr);
            QObject::connect(process, &QProcess::finished, process, &QObject::deleteLater);
        }
    }
}

void probeVersion(const Launch &launch, VersionProbeOwner &owner,
                  std::function<void(const QString &version)> done)
{
    if (owner.cancelled()) return;
    const QString key = probeCacheKey(launch);
    // A package manager can replace the target of an unchanged shim. Every actual
    // launch needs a fresh answer, and a failed probe must not retain its old kind.
    probeCache().remove(key);
    auto *process = new QProcess(&owner);
    process->setProgram(launch.program);
    process->setWorkingDirectory(launch.cwd);
    process->setProcessEnvironment(launch.environment);
    process->setProcessChannelMode(QProcess::SeparateChannels);
#ifdef Q_OS_WIN
    if (!launch.nativeVersionArguments.isEmpty()) {
        // npm shim: the whole cmd.exe command line must stay verbatim.
        process->setNativeArguments(launch.nativeVersionArguments);
    } else
#endif
    if (launch.viaWsl) {
        process->setArguments(launch.versionArguments);
    } else {
        process->setArguments(QStringList{QStringLiteral("--version")});
    }
    // Timeout kills the process, which also emits finished. Only one callback may
    // create a runtime, and a transient probe failure must remain retryable.
    const auto completed = std::make_shared<bool>(false);
    auto finish = [process, key, done, completed, owner = QPointer<VersionProbeOwner>(&owner)](const QString &version) {
        if (std::exchange(*completed, true)) return;
        process->deleteLater();
        if (!owner || owner->cancelled()) return;
        if (!version.isEmpty()) probeCache().insert(key, version);
        done(version);
    };
    QObject::connect(process, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), process,
                     [process, finish](int exitCode, QProcess::ExitStatus status) {
                         finish(exitCode == 0 && status == QProcess::NormalExit
                             ? QString::fromUtf8(process->readAllStandardOutput()).trimmed()
                             : QString());
                     });
    QObject::connect(process, &QProcess::errorOccurred, process,
                     [process, finish](QProcess::ProcessError error) {
                         if (error == QProcess::FailedToStart) finish(QString());
                     });
    QTimer::singleShot(5'000, process, [process, finish]() {
        if (process->state() != QProcess::NotRunning) process->kill();
        finish(QString());
    });
    process->start();
}

} // namespace pilaunch
