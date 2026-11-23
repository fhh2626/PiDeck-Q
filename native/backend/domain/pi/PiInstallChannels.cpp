#include "ChannelContext.h"

#include "BackgroundWork.h"
#include "PiCli.h"
#include "PiLocator.h"
#include "PiLocatorProbe.h"
#include "SettingsCatalog.h"

#include <QDir>
#include <QJsonArray>
#include <QJsonObject>
#include <QProcessEnvironment>

namespace {

QJsonObject readSettings(const ChannelServices &services)
{
    return readSettingsCatalog(QDir(services.userDataDir).filePath(QStringLiteral("settings.json")))
        .settings;
}

QString settingsPath(const ChannelServices &services)
{
    return QDir(services.userDataDir).filePath(QStringLiteral("settings.json"));
}

/**
 * `NpmAvailabilityResult.error` from a failed probe.
 *
 * The oracle surfaces Node's execFile message, which embeds the whole spawned command
 * line ("Command failed: cmd /d /s /c npm --version"). That string is not portable
 * across implementations, so this emits the stderr the user actually needs (or a
 * timeout/start failure notice); the presence of a non-empty `error` is the contract.
 */
QString npmErrorMessage(const picli::Result &result)
{
    const QString stderrLine = result.stderrText.trimmed();
    if (!stderrLine.isEmpty()) return stderrLine;
    if (result.timedOut) return QStringLiteral("npm --version timed out");
    if (!result.started) return QStringLiteral("Unable to start npm");
    return QStringLiteral("npm --version failed");
}

picli::CommandOptions commandOptions(const QProcessEnvironment &environment, const QString &cwd)
{
    picli::CommandOptions options;
    options.environment = environment;
    options.workingDirectory = cwd;
    return options;
}

} // namespace

void registerPiInstallChannels(ChannelRegistry &registry, ChannelServices &services)
{
    // ── pi detection ──────────────────────────────────────────────────────────

    // `pi:check` runs a real `pi --version`, so it belongs on the serial executor: the
    // probe can take up to 8 s (a WSL distro is slower) and must never stall the
    // renderer's HTTP/SSE loop.
    registry.addAsync(QStringLiteral("pi:check"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
        background::runBlocking(
            [&services]() -> QJsonValue {
                const QJsonObject settings = readSettings(services);
                return QJsonValue(pilocator::check(services, settings).toJson());
            },
            [responder](const background::Outcome &outcome) mutable {
                if (!outcome.ok) return responder.reject(outcome.error);
                responder.resolve(outcome.value);
            });
    });

    // Validating a pasted path has a persistent side effect on success: the resolved
    // path (a `.cmd` shim rather than the extension-less sibling) is stored so the next
    // launch uses exactly the executable that just answered `--version`.
    registry.addAsync(QStringLiteral("pi:check-custom"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString customPath = channels::stringArg(args, 0);
        background::runBlocking(
            [&services, customPath]() -> QJsonValue {
                const QJsonObject settings = readSettings(services);
                pilocator::Status status =
                    pilocator::validateCustomPath(services, settings, customPath);
                if (status.installed && status.hasCommand && !status.command.isEmpty()) {
                    // Save the confirmed identity with the path. A supported Pi can
                    // replace an old executable without changing its command name.
                    const QJsonObject installation{
                        {QStringLiteral("command"), status.command},
                        {QStringLiteral("version"), status.version},
                        {QStringLiteral("runtimeKind"), status.runtimeKind},
                    };
                    if (!canPersistCustomPiInstallation(installation)) {
                        status.installed = false;
                    } else {
                        const SettingsCatalogRead updated = updateSettingsCatalog(
                            settingsPath(services),
                            QJsonObject{
                                {QStringLiteral("customPiPath"), status.command},
                                {QStringLiteral("piInstall"), installation},
                            });
                        if (!updated.ok) throw ChannelError(updated.error);
                        status.installed = updated.settings.value(QStringLiteral("customPiPath")).toString()
                            == status.command;
                    }
                    // Migration may reject a retired installation. Report that outcome
                    // instead of claiming the discarded command was saved successfully.
                    if (!status.installed) {
                        status.hasError = true;
                        status.error = services.translate(QStringLiteral("mainPi.checkFailed"), QJsonObject{});
                    }
                }
                return status.toJson();
            },
            [responder](const background::Outcome &outcome) mutable {
                if (!outcome.ok) return responder.reject(outcome.error);
                responder.resolve(outcome.value);
            });
    });

    // ── npm availability ──────────────────────────────────────────────────────

    // npm may only exist in a version-manager directory that a desktop launch does not
    // inherit, which is why the child PATH is rebuilt from the locator's search dirs
    // instead of inheriting this process's PATH.
    registry.addAsync(QStringLiteral("pi:check-npm"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
        background::runBlocking(
            [&services]() -> QJsonValue {
                const QProcessEnvironment environment =
                    pilocator::createProcessEnv(services, QJsonObject{});
                const picli::Result result = picli::runCommand(
                    QStringLiteral("npm"), {QStringLiteral("--version")}, 10'000,
                    commandOptions(environment, QString()));
                if (!result.ok()) {
                    return QJsonValue(QJsonObject{
                        {QStringLiteral("available"), false},
                        {QStringLiteral("error"), npmErrorMessage(result)},
                    });
                }
                return QJsonValue(QJsonObject{
                    {QStringLiteral("available"), true},
                    {QStringLiteral("version"), result.stdoutText.trimmed()},
                });
            },
            [responder](const background::Outcome &outcome) mutable {
                if (!outcome.ok) return responder.reject(outcome.error);
                responder.resolve(outcome.value);
            });
    });

    // ── install command ───────────────────────────────────────────────────────

    // The renderer's install dialog owns this string ("npm i -g @earendil-works/pi-coding-agent"
    // and friends), exactly like the oracle: it is handed to `cmd.exe /d /s /c` as a
    // single argument, never concatenated into another command, and it runs in the user
    // home directory with npm's fund/audit network calls disabled.
    registry.addAsync(QStringLiteral("pi:exec-install"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString command = channels::stringArg(args, 0);
        if (command.trimmed().isEmpty()) {
            return responder.reject(QStringLiteral("Missing install command"));
        }
        background::runBlocking(
            [&services, command]() -> QJsonValue {
                QProcessEnvironment environment =
                    pilocator::createProcessEnv(services, QJsonObject{});
                environment.insert(QStringLiteral("npm_config_fund"), QStringLiteral("false"));
                environment.insert(QStringLiteral("npm_config_audit"), QStringLiteral("false"));

                QString program;
                QStringList argv;
#ifdef Q_OS_WIN
                const QString comspec = environment.value(QStringLiteral("ComSpec"));
                program = comspec.isEmpty() ? QStringLiteral("cmd.exe") : comspec;
                argv = QStringList{QStringLiteral("/d"), QStringLiteral("/s"), QStringLiteral("/c"), command};
#else
                program = QStringLiteral("/bin/sh");
                argv = QStringList{QStringLiteral("-c"), command};
#endif
                const picli::Result result = picli::runCommand(
                    program, argv, 120'000, commandOptions(environment, services.hostHome));
                // A spawn failure / timeout has no numeric exit code; the oracle reports
                // -1 for both, which the install dialog renders as "failed".
                const int exitCode = (result.started && !result.timedOut) ? result.exitCode : -1;
                return QJsonValue(QJsonObject{
                    {QStringLiteral("success"), result.ok()},
                    {QStringLiteral("exitCode"), exitCode},
                    {QStringLiteral("stdout"), result.stdoutText},
                    {QStringLiteral("stderr"), result.stderrText},
                });
            },
            [responder](const background::Outcome &outcome) mutable {
                if (!outcome.ok) return responder.reject(outcome.error);
                responder.resolve(outcome.value);
            });
    });
}
