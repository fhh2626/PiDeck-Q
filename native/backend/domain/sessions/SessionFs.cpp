#include "SessionFs.h"

#include "SessionFiles.h"

#include "../extensions/PiCli.h"
#include "../process/ChildEnvironment.h"
#include "../wsl/WslExec.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QProcessEnvironment>
#include <QRegularExpression>
#include <QStandardPaths>

#include <cmath>
#include <limits>

namespace {

constexpr int kCommandTimeoutMs = 15'000;
constexpr int kReadTimeoutMs = 20'000;
constexpr qint64 kMaxCommandOutput = 64 * 1024 * 1024;
constexpr qint64 kMaxListOutput = 16 * 1024 * 1024;

QString wslExecutable(const QString &override)
{
    // One resolver for the `wsl:*` channels and the scanner: a batch-shim fixture must
    // behave identically in both, and production never sees a shell string either way.
    return wsl::executableFor(override);
}

struct CommandResult {
    bool ok = false;
    QString output;
    QString error;
    int exitCode = -1;
};

/**
 * One `wsl -d … -u … <arguments>` capture with the host's sanitized environment.
 *
 * Stdout survives a timeout: the WSL scan batch reconstructs the files the child managed
 * to print before it was killed. An oversized envelope is a *failure*, not a timeout, so
 * the batch falls back to per-file reads instead of trusting a cut record.
 */
sessioncmd::Result runWslCapture(const SessionFs::Config &config, const QStringList &arguments,
                                 int timeoutMs, qint64 maxOutput)
{
    sessioncmd::Result result;
    const QString program = wslExecutable(config.executable);
    if (program.isEmpty()) {
        result.stderrText = QStringLiteral("wsl.exe not found");
        return result;
    }
    const QStringList fullArguments = QStringList{QStringLiteral("-d"), config.distro,
                                                  QStringLiteral("-u"), config.user}
        + arguments;
    picli::CommandOptions options;
    if (maxOutput > 0) options.maxOutputBytes = maxOutput;
    const picli::Result outcome = picli::runCommand(program, fullArguments, timeoutMs, options);
    result.started = outcome.started;
    result.timedOut = outcome.timedOut;
    result.exitCode = outcome.exitCode;
    result.stdoutText = outcome.stdoutText;
    result.stderrText = outcome.stderrText;
    if (maxOutput > 0 && !result.timedOut && result.stdoutText.toUtf8().size() > maxOutput) {
        result.truncated = true;
        result.stdoutText.clear();
        result.stderrText = QStringLiteral("wsl command output too large");
    }
    return result;
}

CommandResult runWsl(const SessionFs::Config &config, const QStringList &arguments, int timeoutMs,
                    qint64 maxOutput)
{
    const sessioncmd::Result captured = runWslCapture(config, arguments, timeoutMs, maxOutput);
    CommandResult result;
    result.exitCode = captured.exitCode;
    result.output = captured.stdoutText;
    // A timeout keeps its partial stdout (the batch reader needs the complete prefix), but
    // every other failure maps to the child's own diagnostics.
    result.error = captured.timedOut ? QStringLiteral("wsl command timed out")
                                     : captured.stderrText.trimmed();
    result.ok = captured.ok();
    return result;
}

/** `test -X` returns 1 (no diagnostics) for a negative result; anything else is an error. */
bool wslTest(const SessionFs::Config &config, const QString &flag, const QString &path, bool *ok)
{
    CommandResult result = runWsl(config, QStringList{QStringLiteral("test"), flag, path}, 10'000, 1024 * 1024);
    if (result.ok) {
        *ok = true;
        return true;
    }
    if (result.exitCode == 1 && result.error.isEmpty()) {
        *ok = true;
        return false;
    }
    *ok = false;
    return false;
}

} // namespace

// Keep the native-filesystem default while allowing all C++20 compilers to see
// the complete nested Config type before its default member initializers run.
SessionFs::SessionFs() : SessionFs(Config{}) {}

SessionFs::SessionFs(Config config) : m_config(std::move(config)) {}

QString SessionFs::join(const QString &base, const QString &name) const
{
    if (base.isEmpty()) return name;
    if (m_config.wsl) {
        QString trimmed = base;
        while (trimmed.endsWith(QLatin1Char('/'))) trimmed.chop(1);
        return trimmed + QLatin1Char('/') + name;
    }
    return QDir(base).filePath(name);
}

QString SessionFs::dirname(const QString &path) const
{
    if (m_config.wsl) {
        const int index = path.lastIndexOf(QLatin1Char('/'));
        if (index <= 0) return QStringLiteral("/");
        return path.left(index);
    }
    return QFileInfo(path).absolutePath();
}

QString SessionFs::basename(const QString &path) const
{
    if (m_config.wsl) {
        const int index = path.lastIndexOf(QLatin1Char('/'));
        return index < 0 ? path : path.mid(index + 1);
    }
    return QFileInfo(path).fileName();
}

QString SessionFs::stem(const QString &path) const
{
    QString name = basename(path);
    if (name.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive)) name.chop(6);
    return name;
}

bool SessionFs::exists(const QString &path) const
{
    if (!m_config.wsl) return sessionfiles::exists(path);
    bool ok = false;
    const bool present = wslTest(m_config, QStringLiteral("-e"), path, &ok);
    return ok && present;
}

bool SessionFs::isFile(const QString &path) const
{
    if (!m_config.wsl) return sessionfiles::isFile(path);
    bool ok = false;
    const bool present = wslTest(m_config, QStringLiteral("-f"), path, &ok);
    return ok && present;
}

bool SessionFs::isDirectory(const QString &path) const
{
    if (!m_config.wsl) return sessionfiles::isDirectory(path);
    bool ok = false;
    const bool present = wslTest(m_config, QStringLiteral("-d"), path, &ok);
    return ok && present;
}

QStringList SessionFs::listNames(const QString &directory) const
{
    if (!m_config.wsl) return sessionfiles::listNames(directory);
    if (!exists(directory)) return {};
    const CommandResult result = runWsl(m_config, QStringList{QStringLiteral("ls"), QStringLiteral("-1A"), directory},
                                        kCommandTimeoutMs, kMaxListOutput);
    if (!result.ok) return {};
    QStringList names;
    for (const QString &line : result.output.split(QLatin1Char('\n'))) {
        if (!line.isEmpty()) names.append(line);
    }
    return names;
}

bool SessionFs::readText(const QString &path, QString *content, QString *error) const
{
    if (!m_config.wsl) return sessionfiles::readText(path, content, error);
    const CommandResult result = runWsl(m_config, QStringList{QStringLiteral("cat"), path}, kReadTimeoutMs, kMaxCommandOutput);
    if (!result.ok) {
        if (error) *error = result.error.isEmpty() ? QStringLiteral("Unable to read %1").arg(path) : result.error;
        return false;
    }
    *content = result.output;
    return true;
}

bool SessionFs::readHead(const QString &path, qint64 maxBytes, QString *content, QString *error) const
{
    if (!m_config.wsl) return sessionfiles::readHead(path, maxBytes, content, error);
    const CommandResult result =
        runWsl(m_config, QStringList{QStringLiteral("head"), QStringLiteral("-c"), QString::number(maxBytes),
                                       QStringLiteral("--"), path},
               10'000, 4 * 1024 * 1024);
    if (!result.ok) {
        if (error) *error = result.error.isEmpty() ? QStringLiteral("Unable to read %1").arg(path) : result.error;
        return false;
    }
    *content = result.output;
    return true;
}

bool SessionFs::writeAtomic(const QString &path, const QString &content, QString *error) const
{
    if (!m_config.wsl) return sessionfiles::writeAtomic(path, content.toUtf8(), error);
    // `dd of=` truncates before writing, so a timeout would leave half a file. Write a
    // sibling temp file and rename (atomic on Linux) instead.
    const QString temp = path + QStringLiteral(".pideck-") + QString::number(QDateTime::currentMSecsSinceEpoch())
        + QStringLiteral(".tmp");
    QProcess process;
    // The content travels over stdin, so the batch-shim wrapping (a `.cmd` fixture is not
    // executable through CreateProcess) has to come from the shared builder rather than a
    // hand-built command line.
    const pilaunch::Cli cli = picli::buildCli(
        wslExecutable(m_config.executable),
        QStringList{QStringLiteral("-d"), m_config.distro, QStringLiteral("-u"), m_config.user,
                    QStringLiteral("dd"), QStringLiteral("of=") + temp, QStringLiteral("bs=1M")},
        childenv::sanitized());
    process.setProcessEnvironment(cli.environment);
#ifdef Q_OS_WIN
    if (!cli.nativeArguments.isEmpty()) {
        process.setNativeArguments(cli.nativeArguments);
        process.start(cli.program);
    } else
#endif
    {
        process.start(cli.program, cli.arguments);
    }
    if (!process.waitForStarted(kCommandTimeoutMs)) {
        if (error) *error = process.errorString();
        return false;
    }
    process.write(content.toUtf8());
    process.closeWriteChannel();
    if (!process.waitForFinished(kReadTimeoutMs) || process.exitCode() != 0) {
        process.kill();
        process.waitForFinished(1'000);
        if (error) *error = QStringLiteral("Unable to write %1").arg(path);
        return false;
    }
    return moveNoClobber(temp, path, error);
}

bool SessionFs::moveNoClobber(const QString &from, const QString &to, QString *error) const
{
    if (!m_config.wsl) return sessionfiles::renameNoOverwrite(from, to, error);
    // `-n` skips silently and may still exit 0, so confirm the source actually left.
    const CommandResult result = runWsl(m_config,
                   QStringList{QStringLiteral("mv"), QStringLiteral("-n"), QStringLiteral("-T"), from, to},
                   kCommandTimeoutMs, 1024 * 1024);
    if (!result.ok) {
        if (error) *error = result.error.isEmpty() ? QStringLiteral("Unable to move %1").arg(from) : result.error;
        return false;
    }
    if (exists(from)) {
        if (error) *error = QStringLiteral("Target already exists: %1").arg(to);
        return false;
    }
    return true;
}

bool SessionFs::removeFile(const QString &path) const
{
    if (!m_config.wsl) return sessionfiles::removeFile(path);
    const CommandResult result = runWsl(m_config, QStringList{QStringLiteral("rm"), QStringLiteral("-f"), path}, 10'000,
                                         1024 * 1024);
    return result.ok;
}

bool SessionFs::makeDirectory(const QString &path) const
{
    if (!m_config.wsl) {
        QString error;
        return sessionfiles::makeDirectory(path, &error);
    }
    const CommandResult result = runWsl(m_config, QStringList{QStringLiteral("mkdir"), QStringLiteral("-p"), path},
                                        kCommandTimeoutMs, 1024 * 1024);
    return result.ok;
}

QStringList SessionFs::collectJsonl(const QString &root, bool allowArchive) const
{
    if (!m_config.wsl) return sessionfiles::collectJsonlFiles(root, allowArchive);
    if (root.isEmpty() || sessionfiles::isIgnoredScanPath(root, allowArchive)) return {};
    QStringList arguments{QStringLiteral("find"), root, QStringLiteral("-name"), QStringLiteral("*.jsonl"),
                          QStringLiteral("-type"), QStringLiteral("f")};
    if (!allowArchive) {
        arguments << QStringLiteral("-not") << QStringLiteral("-path")
                  << QStringLiteral("*/%1/*").arg(QLatin1String(sessionfiles::kArchiveDirName));
    }
    arguments << QStringLiteral("-not") << QStringLiteral("-path")
              << QStringLiteral("*/%1/*").arg(QLatin1String(sessionfiles::kTrashDirName))
              << QStringLiteral("-not") << QStringLiteral("-path") << QStringLiteral("*/subagent-artifacts/*")
              << QStringLiteral("-not") << QStringLiteral("-path")
              << QStringLiteral("*/.pi/subagents/artifacts/*");
    const CommandResult result = runWsl(m_config, arguments, kCommandTimeoutMs, kMaxListOutput);
    if (!result.ok) return {};
    QStringList files;
    for (const QString &line : result.output.split(QLatin1Char('\n'))) {
        const QString trimmed = line.trimmed();
        if (trimmed.isEmpty()) continue;
        if (sessionfiles::isIgnoredScanPath(trimmed, allowArchive)) continue;
        files.append(trimmed);
    }
    return files;
}

bool SessionFs::statVersion(const QString &path, qint64 *mtimeMs, qint64 *size) const
{
    if (!m_config.wsl) {
        const QFileInfo info(path);
        if (!info.exists()) return false;
        *mtimeMs = info.lastModified().toMSecsSinceEpoch();
        *size = info.size();
        return true;
    }
    const CommandResult result = runWsl(m_config, QStringList{QStringLiteral("stat"), QStringLiteral("-c"), QStringLiteral("%Y %s"), path},
                                        10'000, 1024 * 1024);
    if (!result.ok) return false;
    const QStringList parts = result.output.trimmed().split(QRegularExpression(QStringLiteral("\\s+")));
    if (parts.size() < 2) return false;
    // A corrupt or hostile `wsl.exe` can print values outside qint64; both casts below are
    // UB in that case, so the file is reported as un-stattable (a cache miss) instead.
    bool timeOk = false;
    const double seconds = parts.at(0).toDouble(&timeOk);
    bool sizeOk = false;
    const qint64 bytes = parts.at(1).toLongLong(&sizeOk);
    if (!timeOk || !sizeOk || !std::isfinite(seconds) || bytes < 0
        || bytes > (qint64(1) << 53) - 1) {
        return false;
    }
    const double millis = seconds * 1000.0;
    if (!std::isfinite(millis) || millis < double(std::numeric_limits<qint64>::min())
        || millis > double(std::numeric_limits<qint64>::max())) {
        return false;
    }
    *mtimeMs = qint64(millis);
    *size = bytes;
    return true;
}

sessioncmd::Result SessionFs::runCapture(const QStringList &arguments, int timeoutMs,
                                         qint64 maxOutput) const
{
    // Only the WSL adapter owns a child at all; a native adapter has nothing to execute and
    // says so instead of silently returning an empty "success".
    if (!m_config.wsl) {
        sessioncmd::Result result;
        result.stderrText = QStringLiteral("WSL environment unavailable");
        return result;
    }
    return runWslCapture(m_config, arguments, timeoutMs, maxOutput);
}
