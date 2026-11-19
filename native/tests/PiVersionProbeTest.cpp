#include "PiLaunch.h"

#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QThread>
#include <QTimer>
#include <QTemporaryDir>

#include <cstdio>
#include <memory>

/** Exercise the public asynchronous probe against this executable as a fake CLI. */
int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    if (app.arguments().contains(QStringLiteral("--version"))) {
        QFile log(qEnvironmentVariable("PIDECK_TEST_PROBE_LOG"));
        if (!log.fileName().isEmpty() && log.open(QIODevice::WriteOnly | QIODevice::Append)) {
            log.write(QJsonDocument(QJsonObject{
                {QStringLiteral("pid"), double(QCoreApplication::applicationPid())},
            }).toJson(QJsonDocument::Compact) + '\n');
            log.close();
        }
        const QString mode = qEnvironmentVariable("PIDECK_TEST_PROBE_MODE");
        if (mode == QLatin1String("timeout")) QThread::msleep(6'000);
        const QString version = qEnvironmentVariable("PIDECK_TEST_PROBE_VERSION", QStringLiteral("1.4.0"));
        std::fputs((version + QLatin1Char('\n')).toUtf8().constData(), stdout);
        std::fflush(stdout);
        return mode == QLatin1String("failure") ? 1 : 0;
    }

    const QString mode = app.arguments().value(1);
    pilaunch::Launch launch;
    launch.program = QCoreApplication::applicationFilePath();
    launch.cwd = QDir::currentPath();
    launch.environment = QProcessEnvironment::systemEnvironment();
    launch.environment.insert(QStringLiteral("PIDECK_TEST_PROBE_MODE"), mode);
    if (mode == QLatin1String("cancel") || mode == QLatin1String("destroy")) {
        QTemporaryDir temporary;
        const QString logPath = temporary.filePath(QStringLiteral("probe.jsonl"));
        launch.environment.insert(QStringLiteral("PIDECK_TEST_PROBE_MODE"), QStringLiteral("timeout"));
        launch.environment.insert(QStringLiteral("PIDECK_TEST_PROBE_LOG"), logPath);
        auto owner = std::make_unique<pilaunch::VersionProbeOwner>();
        int callbacks = 0;
        qint64 elapsed = -1;
        QJsonObject child;
        QEventLoop loop;
        pilaunch::probeVersion(launch, *owner, [&](const QString &) { ++callbacks; });
        QTimer poll;
        QObject::connect(&poll, &QTimer::timeout, &loop, [&]() {
            if (QFileInfo(logPath).size() <= 0) return;
            poll.stop();
            QFile log(logPath);
            if (log.open(QIODevice::ReadOnly)) child = QJsonDocument::fromJson(log.readAll()).object();
            QElapsedTimer timer;
            timer.start();
            if (mode == QLatin1String("cancel")) owner->cancel();
            else owner.reset();
            elapsed = timer.elapsed();
            QTimer::singleShot(150, &loop, &QEventLoop::quit);
        });
        poll.start(10);
        QTimer::singleShot(4'000, &loop, &QEventLoop::quit);
        loop.exec();
        const QJsonObject result{{QStringLiteral("callbacks"), callbacks},
            {QStringLiteral("elapsedMs"), double(elapsed)},
            {QStringLiteral("pid"), child.value(QStringLiteral("pid"))}};
        std::fputs(QJsonDocument(result).toJson(QJsonDocument::Compact).constData(), stdout);
        return 0;
    }
    pilaunch::VersionProbeOwner owner;
    QJsonArray initial;
    QJsonArray retried;
    QEventLoop first;
    pilaunch::probeVersion(launch, owner, [&](const QString &version) {
        initial.append(version);
        // Keep processing process-exit signals after timeout completion. A second
        // callback would be observable to a runtime caller as a second launch.
        QTimer::singleShot(100, &first, &QEventLoop::quit);
    });
    QTimer::singleShot(8'000, &first, &QEventLoop::quit);
    first.exec();
    const QString cachedAfterInitial = pilaunch::cachedVersion(launch);

    launch.environment.remove(QStringLiteral("PIDECK_TEST_PROBE_MODE"));
    if (mode.startsWith(QLatin1String("refresh"))) {
        // The command path stays fixed while the installed implementation changes.
        // A failed replacement probe must not leave the former version cached.
        launch.environment.insert(QStringLiteral("PIDECK_TEST_PROBE_VERSION"), QStringLiteral("1.5.0"));
        if (mode == QLatin1String("refresh-failure")) {
            launch.environment.insert(QStringLiteral("PIDECK_TEST_PROBE_MODE"), QStringLiteral("failure"));
        } else if (mode == QLatin1String("refresh-timeout")) {
            launch.environment.insert(QStringLiteral("PIDECK_TEST_PROBE_MODE"), QStringLiteral("timeout"));
        }
    }
    QEventLoop second;
    pilaunch::probeVersion(launch, owner, [&](const QString &version) {
        retried.append(version);
        QTimer::singleShot(100, &second, &QEventLoop::quit);
    });
    const QString cachedDuringRetry = pilaunch::cachedVersion(launch);
    QTimer::singleShot(8'000, &second, &QEventLoop::quit);
    second.exec();
    const QJsonObject result{
        {QStringLiteral("initial"), initial},
        {QStringLiteral("retried"), retried},
        {QStringLiteral("cachedDuringRetry"), cachedDuringRetry},
        {QStringLiteral("cachedAfterInitial"), cachedAfterInitial},
        {QStringLiteral("cachedAfterRetry"), pilaunch::cachedVersion(launch)},
    };
    std::fputs(QJsonDocument(result).toJson(QJsonDocument::Compact).constData(), stdout);
    return 0;
}
