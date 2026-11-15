#include "PiProcess.h"

#include <QProcess>

namespace piprocess {
namespace {

constexpr qint64 kMaxOutputBytes = 32 * 1024 * 1024;
constexpr int kSliceMs = 20;

} // namespace

Result run(const pilaunch::Cli &cli, int timeoutMs, const QString &cwd)
{
    Result result;
    QProcess process;
    process.setProcessEnvironment(cli.environment);
    if (!cwd.isEmpty()) process.setWorkingDirectory(cwd);
    process.setProcessChannelMode(QProcess::SeparateChannels);
    if (!cli.nativeArguments.isEmpty()) {
        // npm batch shim: the command line produced by pilaunch must stay verbatim,
        // otherwise QProcess would escape the inner quotes cmd.exe /s /c expects.
        process.setNativeArguments(cli.nativeArguments);
        process.start(cli.program);
    } else {
        process.start(cli.program, cli.arguments);
    }
    if (!process.waitForStarted(10'000)) return result;
    result.started = true;

    QByteArray stdoutBytes;
    int waitedMs = 0;
    while (process.state() != QProcess::NotRunning) {
        if (process.waitForFinished(kSliceMs)) break;
        stdoutBytes.append(process.readAllStandardOutput());
        waitedMs += kSliceMs;
        if (stdoutBytes.size() > kMaxOutputBytes) {
            process.kill();
            process.waitForFinished(2'000);
            break;
        }
        if (waitedMs >= timeoutMs) {
            result.timedOut = true;
            process.kill();
            process.waitForFinished(2'000);
            break;
        }
    }
    stdoutBytes.append(process.readAllStandardOutput());
    result.stdoutBytes = stdoutBytes;
    result.stdoutText = QString::fromUtf8(stdoutBytes);
    result.stderrBytes = process.readAllStandardError();
    result.stderrText = QString::fromUtf8(result.stderrBytes);
    result.exitCode = process.exitCode();
    if (process.exitStatus() == QProcess::CrashExit && !result.timedOut) {
        // The oracle maps a signal/abnormal exit to -1 when there is no numeric code.
        result.exitCode = result.exitCode == 0 ? -1 : result.exitCode;
    }
    return result;
}

} // namespace piprocess
