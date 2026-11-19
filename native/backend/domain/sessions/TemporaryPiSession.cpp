#include "TemporaryPiSession.h"

#include "SessionIdentity.h"

#include "../../pi/PiCommand.h"
#include "../../pi/PiEventClient.h"

#include <QJsonDocument>
#include <QProcessEnvironment>

#include <memory>

namespace temporarypi {

QStringList buildArguments(const QJsonObject &settings, const QString &sessionPath)
{
    QStringList arguments{QStringLiteral("--mode"), QStringLiteral("rpc"), QStringLiteral("--no-themes")};
    // Temporary operations do not probe a version. Only an explicit TypeScript choice
    // can establish support for this optional flag; an auto command named `pi` may be
    // a standalone build, whose copy/export RPC must still start successfully.
    const bool offline = settings.value(QStringLiteral("piRpcOffline")).toBool(true);
    if (offline && settings.value(QStringLiteral("piRuntimePreference")).toString() == QLatin1String("typescript")) {
        arguments.append(QStringLiteral("--offline"));
    }
    if (settings.value(QStringLiteral("piRpcNoExtensions")).toBool(false)) {
        arguments.append(QStringLiteral("--no-extensions"));
    }
    if (settings.value(QStringLiteral("piRpcNoSkills")).toBool(false)) {
        arguments.append(QStringLiteral("--no-skills"));
    }
    if (!sessionPath.isEmpty()) arguments << QStringLiteral("--session") << sessionPath;
    return arguments;
}

void run(const QJsonObject &settings, const QString &cwd, const QString &sessionPath,
         const QJsonObject &command, int timeoutMs, Done done)
{
    const picommand::Invocation invocation = picommand::resolve(settings);
    if (invocation.program.isEmpty()) {
        Result result;
        result.error = QStringLiteral("pi executable not found");
        done(result);
        return;
    }
    QStringList arguments = invocation.arguments;
    arguments.append(buildArguments(settings, sessionPath));

    auto client = std::make_shared<PiEventClient>();
    auto settled = std::make_shared<bool>(false);
    auto finish = [settled, done](Result result) {
        if (*settled) return;
        *settled = true;
        done(result);
    };
    if (!client->start(invocation.program, arguments, cwd, picommand::environment(settings, invocation))) {
        Result result;
        result.error = QStringLiteral("Unable to start pi");
        finish(result);
        return;
    }
    client->request(command, timeoutMs, [client, finish](bool ok, const QJsonObject &response, const QString &error) {
        Result result;
        if (!ok) {
            result.error = error.isEmpty() ? QStringLiteral("pi command failed") : error;
            client->close(QStringLiteral("done"));
            finish(result);
            return;
        }
        if (!response.value(QStringLiteral("success")).toBool(true)) {
            const QJsonValue responseError = response.value(QStringLiteral("error"));
            result.error = responseError.isString() ? responseError.toString()
                                                    : QStringLiteral("pi command failed");
            client->close(QStringLiteral("done"));
            finish(result);
            return;
        }
        result.ok = true;
        result.data = response.value(QStringLiteral("data")).toObject();
        client->close(QStringLiteral("done"));
        finish(result);
    });
}

void clone(const QJsonObject &settings, const QString &cwd, const QString &sessionPath,
           const QString &projectPath, const QString &environment, Done done)
{
    const picommand::Invocation invocation = picommand::resolve(settings);
    if (invocation.program.isEmpty()) {
        Result result;
        result.error = QStringLiteral("pi executable not found");
        done(result);
        return;
    }
    QStringList arguments = invocation.arguments;
    arguments.append(buildArguments(settings, sessionPath));

    auto client = std::make_shared<PiEventClient>();
    auto settled = std::make_shared<bool>(false);
    auto finish = [client, settled, done](Result result) {
        if (*settled) return;
        *settled = true;
        client->close(QStringLiteral("done"));
        done(result);
    };
    if (!client->start(invocation.program, arguments, cwd, picommand::environment(settings, invocation))) {
        Result result;
        result.error = QStringLiteral("Unable to start pi");
        finish(result);
        return;
    }
    // `clone` copies the active branch; the new file path only arrives via `get_state`.
    client->request(QJsonObject{{QStringLiteral("type"), QStringLiteral("clone")}}, 120'000,
                    [settings, projectPath, environment, client, finish](
                        bool ok, const QJsonObject &response, const QString &error) {
                        if (!ok) {
                            Result result;
                            result.error = error.isEmpty() ? QStringLiteral("pi command failed") : error;
                            finish(result);
                            return;
                        }
                        if (!response.value(QStringLiteral("success")).toBool(true)) {
                            const QJsonValue responseError = response.value(QStringLiteral("error"));
                            Result result;
                            result.error = responseError.isString()
                                ? responseError.toString()
                                : QStringLiteral("pi command failed");
                            finish(result);
                            return;
                        }
                        QJsonObject data = response.value(QStringLiteral("data")).toObject();
                        // The oracle waits with the user-configured RPC timeout, not a
                        // hard-coded 30 s: a large clone may legitimately take longer.
                        int stateTimeout = settings.value(QStringLiteral("rpcTimeout")).toInt(600'000);
                        if (stateTimeout <= 0) stateTimeout = 600'000;
                        client->request(
                            QJsonObject{{QStringLiteral("type"), QStringLiteral("get_state")}},
                            stateTimeout,
                            [projectPath, environment, data, finish](bool stateOk,
                                                                     const QJsonObject &stateResponse,
                                                                     const QString &stateError) mutable {
                                if (!stateOk) {
                                    Result result;
                                    result.error = stateError.isEmpty()
                                        ? QStringLiteral("pi command failed")
                                        : stateError;
                                    finish(result);
                                    return;
                                }
                                if (!stateResponse.value(QStringLiteral("success")).toBool(true)) {
                                    const QJsonValue stateValue =
                                        stateResponse.value(QStringLiteral("error"));
                                    Result result;
                                    result.error = stateValue.isString()
                                        ? stateValue.toString()
                                        : QStringLiteral("pi command failed");
                                    finish(result);
                                    return;
                                }
                                const QJsonObject state =
                                    stateResponse.value(QStringLiteral("data")).toObject();
                                const QString sessionFile =
                                    state.value(QStringLiteral("sessionFile")).toString();
                                if (!sessionFile.isEmpty()) {
                                    // pi may report a project-relative path; storing it
                                    // verbatim would mint a second catalog identity.
                                    data.insert(QStringLiteral("sessionPath"),
                                                sessionidentity::toAbsoluteSessionPath(
                                                    sessionFile, projectPath, environment));
                                }
                                Result result;
                                result.ok = true;
                                result.data = data;
                                finish(result);
                            });
                    });
}

} // namespace temporarypi
