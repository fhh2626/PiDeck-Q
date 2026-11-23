#include "PiLocatorProbe.h"

#include "ChannelContext.h"
#include "CmdLine.h"
#include "PiLocator.h"
#include "PiProcess.h"
#include "../wsl/WslExec.h"

#include <QFileInfo>
#include <QJsonArray>
#include <QRegularExpression>

namespace pilocator {
namespace {

/** UTF-8 when it decodes cleanly, otherwise the Windows ANSI code page (GBK on zh-CN). */
QString decodeOutput(const QByteArray &bytes)
{
    if (bytes.isEmpty()) return QString();
    const QString utf8 = QString::fromUtf8(bytes);
    if (!utf8.contains(QChar::ReplacementCharacter)) return utf8;
    // The oracle decodes with TextDecoder("gbk") here; on Windows the ANSI code page is
    // GBK for exactly the locale where that matters, so fromLocal8Bit is the same bytes.
    return QString::fromLocal8Bit(bytes);
}

bool isAbsoluteWindowsExe(const QString &command)
{
    static const QRegularExpression drive(QStringLiteral("^(?:[A-Za-z]:[\\\\/]|\\\\)"));
    return drive.match(command).hasMatch()
        && QFileInfo(command).suffix().compare(QLatin1String("exe"), Qt::CaseInsensitive) == 0;
}

/**
 * `createInvocation(command, args)` for a *resolved* command.
 *
 * This deliberately does not go through `pilaunch::buildCli`: that would resolve the
 * command a second time from the raw settings, and `normalizeCustomPath` may have
 * changed it (`C:\tools\pi` -> `C:\tools\pi.cmd`), so the probed program could differ
 * from the one being reported. The `cmd.exe /d /s /c` shape and the quoting come from
 * `cmdline::`, the same helper the session launcher and the extension CLI use.
 */
pilaunch::Cli invocationFor(const ChannelServices &services, const QString &command,
                            const QStringList &arguments, const QProcessEnvironment &environment)
{
    pilaunch::Cli cli;
    cli.environment = environment;
    QString distro;
    QString user;
    QString piCommand;
    if (command.startsWith(QLatin1String("wsl://"))) {
        cli.program = wsl::executable(services);
        if (parseWslUrl(command, &distro, &user, &piCommand)) {
            cli.arguments = QStringList{QStringLiteral("-d"), distro, QStringLiteral("-u"), user,
                                        piCommand};
        }
        cli.arguments.append(arguments);
        return cli;
    }
    cli.program = command;
    cli.arguments = arguments;
#ifdef Q_OS_WIN
    if (!isAbsoluteWindowsExe(command)) {
        const QString comspec = environment.value(QStringLiteral("ComSpec"));
        cli.program = comspec.isEmpty() ? QStringLiteral("cmd.exe") : comspec;
        cli.arguments.clear();
        cli.nativeArguments = cmdline::nativeArguments(command, arguments);
    }
#endif
    return cli;
}

pilocator::Status runCheck(const ChannelServices &services, const QString &command,
                           const QStringList &searchedDirs)
{
    Status status;
    status.hasCommand = true;
    status.command = command;
    status.searchedDirs = searchedDirs;

    bool viaWsl = command.startsWith(QLatin1String("wsl://"));
    const QProcessEnvironment environment = createProcessEnv(services, QJsonObject{},
                                                             commandBinDir(command), viaWsl);
    const pilaunch::Cli cli = invocationFor(services, command, {QStringLiteral("--version")}, environment);
    const piprocess::Result result = piprocess::run(cli, 8'000);
    if (!result.ok()) {
        status.hasError = true;
        status.error = services.translate(QStringLiteral("mainPi.checkFailed"), QJsonObject{});
        return status;
    }
    status.installed = true;
    status.hasVersion = true;
    status.version = decodeOutput(result.stdoutBytes).trimmed();
    status.hasRuntimeKind = true;
    status.runtimeKind = detectRuntimeKind(status.version);
    return status;
}

pilocator::Status checkWslCommand(const ChannelServices &services, const QString &distro,
                                  const QString &user, const QString &piCommand)
{
    Status status;
    const QString command = QStringLiteral("wsl -d %1 -u %2 %3").arg(distro, user, piCommand);
    const wsl::Result result =
        wsl::run(services, {QStringLiteral("-d"), distro, QStringLiteral("-u"), user, piCommand,
                            QStringLiteral("--version")},
                 8'000);
    if (!result.ok()) {
        status.hasError = true;
        status.error = services.translate(QStringLiteral("mainPi.checkFailed"), QJsonObject{});
        return status;
    }
    status.installed = true;
    status.hasCommand = true;
    status.command = command;
    status.hasVersion = true;
    status.version = result.stdoutText.trimmed();
    status.hasRuntimeKind = true;
    status.runtimeKind = detectRuntimeKind(status.version);
    return status;
}

} // namespace

QJsonObject Status::toJson() const
{
    QJsonObject json{{QStringLiteral("installed"), installed}};
    if (hasCommand) json.insert(QStringLiteral("command"), command);
    if (hasVersion) json.insert(QStringLiteral("version"), version);
    if (hasRuntimeKind) json.insert(QStringLiteral("runtimeKind"), runtimeKind);
    json.insert(QStringLiteral("searchedDirs"), QJsonArray::fromStringList(searchedDirs));
    if (hasError) json.insert(QStringLiteral("error"), error);
    return json;
}

Status check(const ChannelServices &services, const QJsonObject &settings)
{
    const QString preference = settings.value(QStringLiteral("piRuntimePreference")).toString().trimmed();
    const QString normalizedCustom =
        normalizeCustomPath(settings.value(QStringLiteral("customPiPath")).toString());
    if ((preference.isEmpty() || preference == QLatin1String("auto")) && !normalizedCustom.isEmpty()
        && isUnsupportedPowerShellShim(normalizedCustom)) {
        Status status;
        status.hasCommand = true;
        status.command = normalizedCustom;
        status.searchedDirs = searchDirs(services);
        status.hasError = true;
        status.error = services.translate(QStringLiteral("mainPi.powershellUnsupported"), QJsonObject{});
        return status;
    }

    const QString command = resolveCommand(services, settings);
    const QStringList searched = searchDirs(services);
    if (command.startsWith(QLatin1String("wsl://"))) {
        QString distro;
        QString user;
        QString piCommand;
        if (!parseWslUrl(command, &distro, &user, &piCommand)) {
            Status status;
            status.hasCommand = true;
            status.command = command;
            status.hasError = true;
            status.error = services.translate(QStringLiteral("mainPi.invalidWslUrl"), QJsonObject{});
            return status;
        }
        return checkWslCommand(services, distro, user, piCommand);
    }
    return runCheck(services, command, searched);
}

Status validateCustomPath(const ChannelServices &services, const QJsonObject &settings,
                          const QString &customPath)
{
    Q_UNUSED(settings);
    const QString command = normalizeCustomPath(customPath);
    if (command.isEmpty()) {
        Status status;
        status.hasError = true;
        status.error = services.translate(QStringLiteral("mainPi.pathRequired"), QJsonObject{});
        return status;
    }
    if (isUnsupportedPowerShellShim(command)) {
        Status status;
        status.hasCommand = true;
        status.command = command;
        status.hasError = true;
        status.error = services.translate(QStringLiteral("mainPi.powershellUnsupported"), QJsonObject{});
        return status;
    }
    if (command.startsWith(QLatin1String("wsl://"))) {
        QString distro;
        QString user;
        QString piCommand;
        if (!parseWslUrl(command, &distro, &user, &piCommand)) {
            Status status;
            status.hasError = true;
            status.error = services.translate(QStringLiteral("mainPi.invalidWslUrl"), QJsonObject{});
            return status;
        }
        return checkWslCommand(services, distro, user, piCommand);
    }
    return runCheck(services, command, {});
}

} // namespace pilocator
