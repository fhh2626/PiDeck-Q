#include "WslExec.h"

#include "ChannelContext.h"
#include "PiCli.h"

#include <QDir>
#include <QFileInfo>
#include <QRegularExpression>

namespace wsl {
namespace {

QString hostPath(const QString &root, const QString &relative)
{
    if (root.isEmpty()) return relative;
    return QDir::toNativeSeparators(QDir(root).filePath(relative));
}

} // namespace

QString executableFor(const QString &override)
{
    if (!override.trimmed().isEmpty()) return override.trimmed();
#ifdef Q_OS_WIN
    const QString root = qEnvironmentVariable("SystemRoot", QStringLiteral("C:\\Windows"));
    // A 32-bit process is redirected away from System32; Sysnative is the real one.
    QStringList candidates;
    if (sizeof(void *) == 4) candidates.append(hostPath(root, QStringLiteral("Sysnative/wsl.exe")));
    candidates.append(hostPath(root, QStringLiteral("System32/wsl.exe")));
    for (const QString &candidate : candidates) {
        if (QFileInfo::exists(candidate)) return candidate;
    }
#endif
    // Same fallback as the oracle's `{ command: "wsl", shell: true }`: let PATH resolve
    // it. The runner wraps a `.cmd` shim, so no shell string is ever built by hand.
    return QStringLiteral("wsl");
}

QString executable(const ChannelServices &services)
{
    return executableFor(services.wslExe);
}

Result run(const ChannelServices &services, const QStringList &arguments, int timeoutMs)
{
    const picli::Result outcome = picli::runCommand(executable(services), arguments, timeoutMs);
    Result result;
    result.started = outcome.started;
    result.timedOut = outcome.timedOut;
    result.exitCode = outcome.exitCode;
    result.stdoutText = outcome.stdoutText;
    result.stderrText = outcome.stderrText;
    return result;
}

QStringList listDistros(const ChannelServices &services)
{
#ifdef Q_OS_WIN
    const Result result = run(services, {QStringLiteral("-l"), QStringLiteral("-q")}, 10'000);
    if (!result.ok()) return {};
    // `wsl -l -q` is UTF-16LE on Windows; the decode above is UTF-8, so a real distro
    // list arrives NUL-interleaved and is filtered out (oracle parity: it filters the
    // same bytes), while a plain-text fixture stays usable. Junk lines carrying a path
    // separator are the WSL "no distros" banner and are dropped too.
    static const QRegularExpression lineBreak(QStringLiteral("\r?\n"));
    QStringList distros;
    for (const QString &raw : result.stdoutText.split(lineBreak)) {
        const QString trimmed = raw.trimmed();
        if (trimmed.isEmpty()) continue;
        if (trimmed.contains(QLatin1Char('\\'))) continue;
        if (trimmed.contains(QChar(0))) continue;
        distros.append(trimmed);
    }
    return distros;
#else
    // WSL is a Windows-only capability; the renderer keeps the same empty list.
    Q_UNUSED(services);
    return {};
#endif
}

QJsonObject Validation::toJson() const
{
    return QJsonObject{
        {QStringLiteral("ok"), ok},
        {QStringLiteral("whoami"), whoami},
        {QStringLiteral("piVersion"), piVersion},
        {QStringLiteral("error"), error},
    };
}

Validation validateConnection(const ChannelServices &services, const QString &distro,
                              const QString &user)
{
    Validation validation;
#ifndef Q_OS_WIN
    Q_UNUSED(distro);
    Q_UNUSED(user);
    validation.error = services.translate(QStringLiteral("wsl.windowsOnly"), QJsonObject{});
    return validation;
#else
    const QStringList prefix{QStringLiteral("-d"), distro, QStringLiteral("-u"), user};
    const Result whoami = run(services, QStringList(prefix) << QStringLiteral("whoami"), 10'000);
    if (!whoami.ok()) {
        // The distro or user cannot be reached at all.
        validation.error = services.translate(QStringLiteral("wsl.connectionFailed"), QJsonObject{});
        return validation;
    }
    const Result version =
        run(services, QStringList(prefix) << QStringLiteral("pi") << QStringLiteral("--version"), 10'000);
    validation.ok = true;
    validation.whoami = whoami.stdoutText.trimmed();
    validation.piVersion = version.ok() ? version.stdoutText.trimmed() : QString();
    if (validation.piVersion.isEmpty()) {
        validation.error = services.translate(QStringLiteral("wsl.piNotInstalled"), QJsonObject{});
    }
    return validation;
#endif
}

} // namespace wsl
