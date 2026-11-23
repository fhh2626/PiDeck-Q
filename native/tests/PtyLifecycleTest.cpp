#include "PtyProcess.h"

#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QTemporaryDir>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <mutex>

/** Exercise actual ConPTY input, EOF and descendant teardown without a UI. */
int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
#ifndef Q_OS_WIN
    return 0;
#else
    QTemporaryDir directory;
    if (!directory.isValid()) return 1;
    const QString command = QDir(qEnvironmentVariable("SystemRoot", "C:/Windows"))
        .filePath(QStringLiteral("System32/cmd.exe"));
    for (const bool liveChild : {false, true}) {
        std::mutex mutex;
        std::condition_variable changed;
        QByteArray output;
        std::atomic<int> exits{0};
        std::atomic<int> exitCode{-1};
        QString error;
        auto process = terminal::PtyProcess::spawn(command,
            {QStringLiteral("/D"), QStringLiteral("/Q")}, directory.path(), {},
            QProcessEnvironment::systemEnvironment(), {
                [&](const QByteArray &data) {
                    std::lock_guard lock(mutex);
                    output += data;
                    changed.notify_all();
                },
                [&](int code) { std::lock_guard lock(mutex); exitCode = code; ++exits; changed.notify_all(); },
            }, &error);
        // The caret keeps the marker out of echoed input; only executed output matches.
        if (!process || !process->write("echo PIDECK_^READY\r\n", &error)) {
            std::fprintf(stderr, "PTY startup failed: %s\n", qUtf8Printable(error));
            return 1;
        }
        {
            std::unique_lock lock(mutex);
            if (!changed.wait_for(lock, std::chrono::seconds(10), [&] {
                    return output.contains("PIDECK_READY") || exits.load() != 0;
                }) || exits.load() != 0) {
                std::fprintf(stderr, "PTY input failed: code=%d output=[%s]\n", exitCode.load(), output.constData());
                return 1;
            }
        }
        if (liveChild) {
            if (!process->write("cmd /D /Q /C \"echo PIDECK_^CHILD & ping -n 60 127.0.0.1\"\r\n", &error)) return 1;
            std::unique_lock lock(mutex);
            if (!changed.wait_for(lock, std::chrono::seconds(5), [&] {
                    return output.contains("PIDECK_CHILD") || exits.load() != 0;
                }) || exits.load() != 0) {
                std::fprintf(stderr, "PTY descendant did not start\n");
                return 1;
            }
        } else {
            if (!process->write("exit\r\n", &error)) return 1;
            std::unique_lock lock(mutex);
            if (!changed.wait_for(lock, std::chrono::seconds(3), [&] { return exits.load() == 1; })) {
                std::fprintf(stderr, "PTY EOF was not delivered after natural exit\n");
                return 1;
            }
        }
        QElapsedTimer elapsed;
        elapsed.start();
        process->kill();
        process->kill();
        process.reset();
        const auto duration = elapsed.elapsed();
        if (duration >= 1'200 || exits.load() != 1) {
            std::fprintf(stderr, "PTY teardown exceeded budget: %lld ms, %d exits\n",
                         static_cast<long long>(duration), exits.load());
            return 1;
        }
    }
    std::puts("PTY lifecycle passed (natural EOF, live descendant, idempotent close)");
    return 0;
#endif
}
