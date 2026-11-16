#include "PiLaunch.h"

#include <QHash>
#include <QProcess>
#include <QRegularExpression>
#include <QTimer>

/**
 * pi version probing and trust-flag gating (declared in PiLaunch.h).
 *
 * Split out of `PiLaunch.cpp`, which owns launch/argv/env assembly and was already past the
 * file-size budget. Nothing here builds a command line: it only asks the *resolved* launch
 * for `--version` (with the npm-shim/WSL argv forms the launcher already prepared) and
 * caches the answer per resolved command, exactly like `PiProcess.ensureVersionCheck`.
 */
namespace pilaunch {
namespace {

/**
 * Keyed by the *probe* command, not by the full launch: `--session`/`--extension` differ
 * per session while the `--version` answer does not. Keying on the whole argv made every
 * session start spawn another probe and made a warm entry impossible to hit. This is the
 * oracle's "cached per resolved command" (PiProcess.ensureVersionCheck).
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

bool supportsTrustFlags(const QString &version)
{
    const QString value = version.trimmed();
    if (value.isEmpty()) return false;
    if (value.contains(QLatin1String("rust"), Qt::CaseInsensitive)) return false;
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

void probeVersion(const Launch &launch, std::function<void(const QString &version)> done)
{
    const QString key = probeCacheKey(launch);
    QHash<QString, QString> &cache = probeCache();
    const auto cached = cache.constFind(key);
    if (cached != cache.constEnd()) {
        done(*cached);
        return;
    }
    auto *process = new QProcess();
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
    auto finish = [process, key, done](const QString &version) {
        probeCache().insert(key, version);
        process->deleteLater();
        done(version);
    };
    QObject::connect(process, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), process,
                     [process, finish](int, QProcess::ExitStatus) {
                         finish(QString::fromUtf8(process->readAllStandardOutput()).trimmed());
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
