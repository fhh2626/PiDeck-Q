#include "GitExec.h"
#include "../../process/TextEncoding.h"

#include "ChildEnvironment.h"

#include <QProcess>

#include <stdexcept>

namespace gitexec {

QString Result::errorMessage() const
{
    const QStringList lines = stderrText.split(QLatin1Char('\n'), Qt::SkipEmptyParts);
    for (const QString &line : lines) {
        const QString trimmed = line.trimmed();
        if (!trimmed.isEmpty()) return trimmed;
    }
    if (timedOut) return QStringLiteral("git command timed out");
    if (truncated) return QStringLiteral("git output exceeded the size limit");
    if (!started) return QStringLiteral("Unable to start git");
    return QStringLiteral("git command failed");
}

Result run(const QString &cwd, const QStringList &arguments, int timeoutMs, qint64 maxBytes)
{
    Result result;
    QProcess process;
    // Git hooks and credential helpers are ordinary child processes; none of them
    // may see the host bridge token.
    process.setProcessEnvironment(childenv::sanitized());
    process.setWorkingDirectory(cwd);
    process.start(QStringLiteral("git"), arguments);
    if (!process.waitForStarted(10'000)) {
        result.started = false;
        return result;
    }
    result.started = true;

    QByteArray stdoutBytes;
    const auto drain = [&process, &stdoutBytes, maxBytes, &result]() {
        stdoutBytes.append(process.readAllStandardOutput());
        if (maxBytes > 0 && stdoutBytes.size() > maxBytes) result.truncated = true;
    };
    // Poll in short slices so the byte cap and the deadline are both enforced while
    // the child is still running, instead of after it produced unbounded output.
    constexpr int kSliceMs = 20;
    int waitedMs = 0;
    while (process.state() != QProcess::NotRunning) {
        if (process.waitForFinished(kSliceMs)) break;
        drain();
        waitedMs += kSliceMs;
        if (result.truncated) {
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
    drain();
    result.stdoutBytes = stdoutBytes;
    result.stdoutText = QString::fromUtf8(stdoutBytes);
    result.stderrText = QString::fromUtf8(process.readAllStandardError());
    result.exitCode = process.exitCode();
    if (process.exitStatus() == QProcess::CrashExit && !result.timedOut && !result.truncated) {
        result.exitCode = result.exitCode == 0 ? -1 : result.exitCode;
    }
    return result;
}

QString runOrThrow(const QString &cwd, const QStringList &arguments, int timeoutMs, qint64 maxBytes)
{
    const Result result = run(cwd, arguments, timeoutMs, maxBytes);
    if (!result.ok()) throw textenc::error(result.errorMessage());
    return result.stdoutText;
}

QString tryRun(const QString &cwd, const QStringList &arguments, int timeoutMs, qint64 maxBytes)
{
    const Result result = run(cwd, arguments, timeoutMs, maxBytes);
    if (!result.ok()) return QString();
    return result.stdoutText.trimmed();
}

} // namespace gitexec
