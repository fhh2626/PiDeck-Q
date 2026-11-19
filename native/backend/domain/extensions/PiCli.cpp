#include "PiCli.h"

#include "CmdLine.h"
#include "../runtime/PiLaunch.h"
#include "ChildEnvironment.h"

#include <QDir>
#include <QFileInfo>
#include <QHash>
#include <QProcess>
#include <QProcessEnvironment>
#include <QStandardPaths>

namespace picli {
namespace {

constexpr qint64 kMaxOutputBytes = 32 * 1024 * 1024;

/**
 * Resolve a bare command name against an explicit PATH.
 *
 * `QStandardPaths::findExecutable` only sees this process's PATH, but npm and wsl must
 * be found in the *child* PATH the locator rebuilt (version-manager directories a
 * desktop launch does not inherit). Windows command resolution order is emulated with
 * the shim extensions Node's `execFile` accepts.
 */
QString resolveInPath(const QString &name, const QProcessEnvironment &environment)
{
    QString pathValue = environment.value(QStringLiteral("PATH"));
    if (pathValue.isEmpty()) pathValue = environment.value(QStringLiteral("Path"));
    if (pathValue.isEmpty()) return QString();
    QStringList names{name};
#ifdef Q_OS_WIN
    if (!name.contains(QLatin1Char('.'))) {
        names = QStringList{name + QStringLiteral(".cmd"), name + QStringLiteral(".exe"),
                            name + QStringLiteral(".bat"), name};
    }
#endif
    const QStringList dirs = pathValue.split(QDir::listSeparator(), Qt::SkipEmptyParts);
    for (const QString &dir : dirs) {
        for (const QString &candidate : names) {
            const QString full = QDir(dir).filePath(candidate);
            if (QFileInfo(full).isFile()) return full;
        }
    }
    return QString();
}


Result runOnce(const pilaunch::Cli &cli, const QStringList &arguments, int timeoutMs,
               const QString &workingDirectory = QString(),
               qint64 maxOutputBytes = kMaxOutputBytes)
{
    Result result;
    QProcess process;
    process.setProcessEnvironment(cli.environment);
    if (!workingDirectory.isEmpty()) process.setWorkingDirectory(workingDirectory);
#ifdef Q_OS_WIN
    if (!cli.nativeArguments.isEmpty()) {
        // A batch shim needs the pre-quoted command line; QProcess would re-escape it.
        process.setNativeArguments(cli.nativeArguments);
        process.start(cli.program);
    } else
#endif
    {
        process.start(cli.program, cli.arguments);
    }
    if (!process.waitForStarted(10'000)) return result;
    result.started = true;

    QByteArray stdoutBytes;
    int waitedMs = 0;
    constexpr int kSliceMs = 20;
    while (process.state() != QProcess::NotRunning) {
        if (process.waitForFinished(kSliceMs)) break;
        stdoutBytes.append(process.readAllStandardOutput());
        waitedMs += kSliceMs;
        if (stdoutBytes.size() > maxOutputBytes) {
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
    result.stdoutText = QString::fromUtf8(stdoutBytes);
    // Keep ordinary command output behavior unchanged, while allowing callers
    // that use stdout as filesystem identity to reject a lossy filename spelling.
    result.stdoutLosslessUtf8 = result.stdoutText.toUtf8() == stdoutBytes;
    result.stderrText = QString::fromUtf8(process.readAllStandardError());
    result.exitCode = process.exitCode();
    if (process.exitStatus() == QProcess::CrashExit && !result.timedOut) {
        result.exitCode = result.exitCode == 0 ? -1 : result.exitCode;
    }
    return result;
}

} // namespace

Result runCommand(const QString &program, const QStringList &arguments, int timeoutMs)
{
    return runCommand(program, arguments, timeoutMs, CommandOptions{});
}

pilaunch::Cli buildCli(const QString &program, const QStringList &arguments,
                       const QProcessEnvironment &environment)
{
    QString resolved = program;
    if (!program.contains(QLatin1Char('/')) && !program.contains(QLatin1Char('\\'))) {
        const QString fromPath = resolveInPath(program, environment);
        if (!fromPath.isEmpty()) {
            resolved = fromPath;
        } else {
            const QString found = QStandardPaths::findExecutable(program);
            if (!found.isEmpty()) resolved = found;
        }
    }
    pilaunch::Cli cli;
    cli.program = resolved;
    cli.arguments = arguments;
    cli.environment = environment;
    const QString programDir = QFileInfo(resolved).absolutePath();
    if (!programDir.isEmpty()) {
        // npm needs node from the same directory on PATH.
        QString path = cli.environment.value(QStringLiteral("PATH"));
        path = programDir + QDir::listSeparator() + path;
        cli.environment.insert(QStringLiteral("PATH"), path);
#ifdef Q_OS_WIN
        cli.environment.insert(QStringLiteral("Path"), path);
#endif
    }
#ifdef Q_OS_WIN
    // npm/npx/pi are `.cmd` shims; CreateProcess cannot execute a batch file. The
    // command line goes through the same `cmdline::` helper as a session launch: the
    // arguments can carry renderer input (an install source, an npm package name), so
    // a whitespace-only quote check would let `&` / `>` reach cmd.exe.
    const QString base = QFileInfo(resolved).fileName().toLower();
    if (base.endsWith(QLatin1String(".cmd")) || base.endsWith(QLatin1String(".bat"))) {
        cli.nativeArguments = cmdline::nativeArguments(resolved, arguments);
        cli.program = QStringLiteral("cmd.exe");
        cli.arguments.clear();
    }
#endif
    return cli;
}

Result runCommand(const QString &program, const QStringList &arguments, int timeoutMs,
                  const CommandOptions &options)
{
    const QProcessEnvironment environment =
        options.environment.isEmpty() ? childenv::sanitized() : options.environment;
    const pilaunch::Cli cli = buildCli(program, arguments, environment);
    // A caller that reads a whole transcript (the WSL scan batch) needs the oracle's 64 MiB
    // per-file budget, which is larger than the default runner ceiling.
    const qint64 maxOutput = options.maxOutputBytes > 0 ? options.maxOutputBytes : kMaxOutputBytes;
    Result result = runOnce(cli, arguments, timeoutMs, options.workingDirectory, maxOutput);
    return result;
}

QString Result::errorMessage() const
{
    const QStringList lines = stderrText.split(QLatin1Char('\n'), Qt::SkipEmptyParts);
    for (const QString &line : lines) {
        const QString trimmed = line.trimmed();
        if (!trimmed.isEmpty()) return trimmed;
    }
    if (timedOut) return QStringLiteral("pi command timed out");
    if (!started) return QStringLiteral("Unable to start pi");
    return QStringLiteral("pi command failed");
}

QString version(const QJsonObject &settings)
{
    // Cache per resolved command: a settings change (custom path, runtime preference)
    // must re-probe, otherwise a stale version decides CLI compatibility forever.
    static QHash<QString, QString> cache;
    const pilaunch::Cli cli = pilaunch::buildCli(settings, {QStringLiteral("--version")});
    const QString key = cli.program + QLatin1Char('\n') + cli.nativeArguments + QLatin1Char('\n')
        + cli.arguments.join(QLatin1Char('\x1f'));
    const auto cached = cache.constFind(key);
    if (cached != cache.constEnd()) return cached.value();
    const Result result = runOnce(cli, {}, 20'000);
    const QString detected = result.ok() ? result.stdoutText.trimmed() : QString();
    if (!detected.isEmpty()) cache.insert(key, detected);
    return detected;
}

Result run(const QJsonObject &settings, const QStringList &arguments, int timeoutMs, bool offline)
{
    QStringList finalArguments = arguments;
    const QString preference = settings.value(QStringLiteral("piRuntimePreference")).toString();
    if (preference != QLatin1String("rust") && pilaunch::supportsProjectApprovalFlag(version(settings))) {
        // Project resources load automatically; pi before 0.79 rejects this option.
        finalArguments.append(QStringLiteral("--approve"));
    }

    pilaunch::Cli cli = pilaunch::buildCli(settings, finalArguments);
    if (offline && cli.runtimeKind != QLatin1String("rust")) {
        // PI_OFFLINE is a TypeScript-pi variable; the Rust build ignores it, so setting
        // it there would only make the environment lie about the runtime.
        QProcessEnvironment env = cli.environment;
        env.insert(QStringLiteral("PI_OFFLINE"), QStringLiteral("1"));
        cli.environment = env;
    }
    return runOnce(cli, finalArguments, timeoutMs);
}

} // namespace picli
