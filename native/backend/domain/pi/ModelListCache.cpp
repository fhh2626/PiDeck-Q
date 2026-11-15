#include "ModelListCache.h"

#include "ChannelContext.h"
#include "ConfigFiles.h"
#include "ModelListParse.h"
#include "ModelThinkingSupport.h"
#include "PiLaunch.h"
#include "PiProcess.h"
#include "SettingsCatalog.h"

#include <QDir>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QProcessEnvironment>
#include <QUuid>

#include <chrono>
#include <stdexcept>
#include <thread>

namespace modellist {
namespace {

constexpr int kRpcTimeoutMs = 20'000;
constexpr int kTextTimeoutMs = 20'000;
constexpr int kStartTimeoutMs = 10'000;
constexpr int kRetryDelayMs = 500;

/** Global model list (`null` in the oracle = not loaded / invalidated). */
Models g_cache;
bool g_hasCache = false;

/** Accelerated text probe: offline skips the network catalogue refresh. */
const QStringList kTextFastArgs{
    QStringLiteral("--list-models"), QStringLiteral("--offline"), QStringLiteral("--no-extensions"),
    QStringLiteral("--no-skills"), QStringLiteral("--no-themes"),
};

/** Neutral text probe: only flags both implementations understand. */
const QStringList kTextNeutralArgs{
    QStringLiteral("--list-models"), QStringLiteral("--no-extensions"),
    QStringLiteral("--no-skills"), QStringLiteral("--no-themes"),
};

/** The stable model-list RPC contract shared by both implementations. */
const QStringList kRpcArgs{
    QStringLiteral("--mode"),           QStringLiteral("rpc"),
    QStringLiteral("--no-session"),     QStringLiteral("--no-extensions"),
    QStringLiteral("--no-skills"),      QStringLiteral("--no-themes"),
};

QJsonObject readSettings(const ChannelServices &services)
{
    return readSettingsCatalog(QDir(services.userDataDir).filePath(QStringLiteral("settings.json")))
        .settings;
}

/**
 * One `get_available_models` round trip on a throw-away pi.
 *
 * Runs on the serial executor, so it waits synchronously for the response line instead
 * of driving the event loop. Spawn failure and early exit both fail fast: the caller
 * falls back to the text table, and a broken pi must not cost the 20 s timeout.
 */
Models runRpcModels(const ChannelServices &services, const QJsonObject &settings)
{
    pilaunch::Cli cli = pilaunch::buildCli(settings, kRpcArgs);
    QProcessEnvironment environment = cli.environment;
    // Match the runtime's offline policy. An environment variable (not `--offline`) is
    // safe for an unknown implementation because unknown variables are ignored.
    if (settings.value(QStringLiteral("piRpcOffline")).toBool(true)) {
        environment.insert(QStringLiteral("PI_OFFLINE"), QStringLiteral("1"));
        if (cli.viaWsl) {
            environment.insert(QStringLiteral("WSLENV"),
                               pilaunch::appendWslEnvName(environment.value(QStringLiteral("WSLENV")),
                                                          QStringLiteral("PI_OFFLINE")));
        }
    }

    QProcess process;
    process.setProcessEnvironment(environment);
    // Startup diagnostics belong on stderr, never in the JSON-RPC stream; drain it so a
    // chatty pi cannot block on a full pipe.
    process.setProcessChannelMode(QProcess::SeparateChannels);
    if (!cli.nativeArguments.isEmpty()) {
        process.setNativeArguments(cli.nativeArguments);
        process.start(cli.program);
    } else {
        process.start(cli.program, cli.arguments);
    }
    if (!process.waitForStarted(kStartTimeoutMs)) {
        throw std::runtime_error("pi model-list process did not start");
    }

    const QString id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    const QJsonObject request{
        {QStringLiteral("type"), QStringLiteral("get_available_models")},
        {QStringLiteral("id"), id},
    };
    process.write(QJsonDocument(request).toJson(QJsonDocument::Compact) + '\n');

    QByteArray buffer;
    QElapsedTimer timer;
    timer.start();
    std::optional<QJsonObject> response;
    while (timer.elapsed() < kRpcTimeoutMs) {
        if (process.waitForReadyRead(100)) buffer.append(process.readAllStandardOutput());
        process.readAllStandardError();
        int newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const QByteArray line = buffer.left(newline);
            buffer.remove(0, newline + 1);
            const QJsonObject message = QJsonDocument::fromJson(line).object();
            if (message.value(QStringLiteral("type")).toString() == QLatin1String("response")
                && message.value(QStringLiteral("id")).toString() == id) {
                response = message;
                break;
            }
            newline = buffer.indexOf('\n');
        }
        if (response) break;
        if (process.state() == QProcess::NotRunning) {
            // Drain whatever was buffered before the child exited, then stop waiting.
            buffer.append(process.readAllStandardOutput());
            int trailing = buffer.indexOf('\n');
            while (trailing >= 0 && !response) {
                const QJsonObject message =
                    QJsonDocument::fromJson(buffer.left(trailing)).object();
                if (message.value(QStringLiteral("type")).toString() == QLatin1String("response")
                    && message.value(QStringLiteral("id")).toString() == id) {
                    response = message;
                }
                buffer.remove(0, trailing + 1);
                trailing = buffer.indexOf('\n');
            }
            if (!response) break;
        }
    }
    if (process.state() != QProcess::NotRunning) {
        process.kill();
        process.waitForFinished(2'000);
    }
    if (!response) throw std::runtime_error("get_available_models timed out");
    if (!response->value(QStringLiteral("success")).toBool(false)) {
        throw std::runtime_error("get_available_models failed");
    }
    return normalizeRpcModels(response->value(QStringLiteral("data")));
}

/** CLI text fallback for older/partial pi builds that do not expose the RPC command. */
Models runTextModels(const ChannelServices &services, const QJsonObject &settings)
{
    const QString preference =
        settings.value(QStringLiteral("piRuntimePreference")).toString().trimmed();
    // Only a TypeScript-compatible selection may pass `--offline`; in auto mode the
    // resolved binary could be Rust, which would fail on the unknown flag.
    QList<QStringList> argumentSets;
    if (preference == QLatin1String("typescript") || preference == QLatin1String("bolt")) {
        argumentSets << kTextFastArgs << kTextNeutralArgs;
    } else {
        argumentSets << kTextNeutralArgs;
    }

    for (int index = 0; index < argumentSets.size(); ++index) {
        const pilaunch::Cli cli = pilaunch::buildCli(settings, argumentSets.at(index));
        const piprocess::Result result = piprocess::run(cli, kTextTimeoutMs);
        if (!result.ok()) continue;
        const Models models = parseTextModels(result.stdoutText);
        if (!models.isEmpty() || index == argumentSets.size() - 1) return models;
    }
    throw std::runtime_error("Unable to list Pi models");
}

/** RPC first, text fallback; throws only when the text fallback has no usable answer. */
Models runListModels(const ChannelServices &services, const QJsonObject &settings)
{
    Models models;
    try {
        models = runRpcModels(services, settings);
    } catch (const std::exception &) {
        models = Models();
    }
    if (!models.isEmpty()) return models;
    return runTextModels(services, settings);
}

/** One probe attempt with the oracle's single empty-result retry. */
Models probe(const ChannelServices &services, const QJsonObject &settings)
{
    Models models = runListModels(services, settings);
    if (!models.isEmpty()) return models;
    // Startup cold start: pi may not be ready yet. Retry once; a failing retry keeps the
    // (empty) first answer instead of turning "no models" into an error.
    std::this_thread::sleep_for(std::chrono::milliseconds(kRetryDelayMs));
    try {
        models = runListModels(services, settings);
    } catch (const std::exception &) {
        // keep the empty first answer
    }
    return models;
}

Models probeAndCache(const ChannelServices &services)
{
    const Models models = probe(services, readSettings(services));
    // Empty results stay uncached so the next invoke retries.
    if (!models.isEmpty()) {
        g_cache = models;
        g_hasCache = true;
    }
    return models;
}

Models decorate(const QString &configDir, const Models &models)
{
    const configfiles::FileRead read = configfiles::read(
        configDir, QStringLiteral("models.json"),
        QJsonObject{{QStringLiteral("providers"), QJsonObject{}}});
    // A corrupt or unreadable models.json must not be read as "no model supports xhigh";
    // the decorator therefore falls back to all-false support instead of a partial map.
    if (read.hasDiagnostic || read.readError) return applyThinkingSupport(models, ThinkingSupportMap());
    return applyThinkingSupport(models, collectThinkingSupport(read.parsed));
}

} // namespace

Models fetch(const ChannelServices &services)
{
    if (g_hasCache) return g_cache;
    return probeAndCache(services);
}

Models refresh(const ChannelServices &services)
{
    invalidate();
    return probeAndCache(services);
}

void invalidate()
{
    g_cache = Models();
    g_hasCache = false;
}

Models listModels(const ChannelServices &services, const QString &configDir)
{
    Models models;
    try {
        models = fetch(services);
    } catch (const std::exception &) {
        return Models();
    }
    return decorate(configDir, models);
}

bool resolveSupport(const ChannelServices &services, const QString &provider,
                    const QString &modelId, ThinkingSupport *support)
{
    if (!support) return false;
    const configfiles::FileRead read = configfiles::read(
        services.configDir, QStringLiteral("models.json"),
        QJsonObject{{QStringLiteral("providers"), QJsonObject{}}});
    // Same distinction the decorator makes, but inverted on purpose: a corrupt file is
    // "unknown" here (no clamp), while the picker degrades to all-false display bits.
    if (read.hasDiagnostic || read.readError) return false;
    const ThinkingSupportMap map = collectThinkingSupport(read.parsed);
    *support = map.value(thinkingSupportKey(provider, modelId));
    return true;
}

} // namespace modellist
