#include "ChannelContext.h"

#include "ConfigFiles.h"
#include "JsonFile.h"
#include "ProviderProbe.h"
#include "TrustBroker.h"

#include <QJsonArray>
#include <QJsonObject>

namespace {

QJsonValue validationJson(const configfiles::Validation &validation)
{
    QJsonObject result{{QStringLiteral("valid"), validation.valid}};
    if (!validation.valid) {
        if (!validation.error.isEmpty()) result.insert(QStringLiteral("error"), validation.error);
        if (!validation.debugDetails.isEmpty()) {
            result.insert(QStringLiteral("debugDetails"), validation.debugDetails);
        }
    }
    return result;
}

QJsonObject fileReadJson(const configfiles::FileRead &read)
{
    QJsonObject result{
        {QStringLiteral("raw"), read.raw},
        {QStringLiteral("parsed"), read.parsed},
    };
    if (read.hasDiagnostic) result.insert(QStringLiteral("diagnostic"), read.diagnostic);
    if (read.readError) result.insert(QStringLiteral("readError"), true);
    return result;
}

} // namespace

void registerConfigChannels(ChannelRegistry &registry, ChannelServices &services)
{
    // ── reads ────────────────────────────────────────────────────────────────

    registry.add(QStringLiteral("config:get-models"), [&services](const QJsonArray &) {
        return QJsonValue(fileReadJson(configfiles::read(
            services.configDir, QStringLiteral("models.json"),
            QJsonObject{{QStringLiteral("providers"), QJsonObject{}}})));
    });

    registry.add(QStringLiteral("config:get-auth"), [&services](const QJsonArray &) {
        return QJsonValue(fileReadJson(
            configfiles::read(services.configDir, QStringLiteral("auth.json"), QJsonObject{})));
    });

    registry.add(QStringLiteral("config:get-settings"), [&services](const QJsonArray &) {
        return QJsonValue(fileReadJson(
            configfiles::read(services.configDir, QStringLiteral("settings.json"), QJsonObject{})));
    });

    // trust.json is owned by the trust broker so the nearest-parent lookup and this raw
    // view can never disagree.
    registry.add(QStringLiteral("config:get-trust"), [&services](const QJsonArray &) {
        if (services.trust) {
            const QJsonObject trust = services.trust->readConfig();
            return QJsonValue(QJsonObject{
                {QStringLiteral("raw"), QString::fromUtf8(jsonfile::prettyJson(trust))},
                {QStringLiteral("parsed"), trust},
            });
        }
        return QJsonValue(fileReadJson(
            configfiles::read(services.configDir, QStringLiteral("trust.json"), QJsonObject{})));
    });

    // ── writes ───────────────────────────────────────────────────────────────

    registry.add(QStringLiteral("config:save-models"), [&services](const QJsonArray &args) {
        const configfiles::Validation validation = configfiles::saveModels(
            services.configDir, channels::argAt(args, 0), services.translate);
        return validationJson(validation);
    });

    registry.add(QStringLiteral("config:save-auth"), [&services](const QJsonArray &args) {
        return validationJson(configfiles::saveAuth(services.configDir, channels::argAt(args, 0)));
    });

    registry.add(QStringLiteral("config:save-settings"), [&services](const QJsonArray &args) {
        return validationJson(configfiles::saveSettings(services.configDir, channels::argAt(args, 0)));
    });

    registry.add(QStringLiteral("config:save-raw"), [&services](const QJsonArray &args) {
        return validationJson(configfiles::saveRaw(services.configDir, channels::stringArg(args, 0),
                                                  channels::stringArg(args, 1), services.translate));
    });

    registry.add(QStringLiteral("config:export"), [&services](const QJsonArray &) {
        return QJsonValue(configfiles::exportPackage(services.configDir));
    });

    registry.add(QStringLiteral("config:import"), [&services](const QJsonArray &args) {
        return validationJson(configfiles::importPackage(
            services.configDir, channels::stringArg(args, 0), services.translate));
    });

    // ── provider probes ──────────────────────────────────────────────────────

    registry.addAsync(QStringLiteral("config:fetch-models"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonObject payload = channels::objectArg(args, 0);
        const QString baseUrl = payload.value(QStringLiteral("baseUrl")).toString();
        const QString apiKey = payload.value(QStringLiteral("apiKey")).toString();
        const QString apiType = payload.value(QStringLiteral("apiType")).toString();
        providerprobe::fetchModels(
            baseUrl, apiKey, apiType, services.translate,
            [responder](const providerprobe::ModelsResult &result) mutable {
                QJsonObject value{{QStringLiteral("success"), result.success}};
                if (result.success) value.insert(QStringLiteral("models"), result.models);
                if (!result.error.isEmpty()) value.insert(QStringLiteral("error"), result.error);
                if (!result.debugDetails.isEmpty()) {
                    value.insert(QStringLiteral("debugDetails"), result.debugDetails);
                }
                if (!result.requestUrl.isEmpty()) {
                    value.insert(QStringLiteral("requestUrl"), result.requestUrl);
                }
                value.insert(QStringLiteral("sessionBaseUrlNeedsVersion"),
                             result.sessionBaseUrlNeedsVersion);
                if (!result.suggestedBaseUrl.isEmpty()) {
                    value.insert(QStringLiteral("suggestedBaseUrl"), result.suggestedBaseUrl);
                }
                responder.resolve(value);
            });
    });

    registry.addAsync(QStringLiteral("config:test-provider"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonObject payload = channels::objectArg(args, 0);
        providerprobe::testConnection(
            payload.value(QStringLiteral("baseUrl")).toString(),
            payload.value(QStringLiteral("apiKey")).toString(),
            payload.value(QStringLiteral("modelId")).toString(),
            payload.value(QStringLiteral("apiType")).toString(),
            payload.value(QStringLiteral("headers")).toObject(), services.translate,
            [responder](const providerprobe::TestResult &result) mutable {
                QJsonObject value{{QStringLiteral("success"), result.success}};
                if (result.success) {
                    value.insert(QStringLiteral("model"), result.model);
                    value.insert(QStringLiteral("snippet"), result.snippet);
                    value.insert(QStringLiteral("tokens"), result.tokens);
                }
                if (!result.error.isEmpty()) value.insert(QStringLiteral("error"), result.error);
                if (!result.debugDetails.isEmpty()) {
                    value.insert(QStringLiteral("debugDetails"), result.debugDetails);
                }
                value.insert(QStringLiteral("latencyMs"), double(result.latencyMs));
                value.insert(QStringLiteral("requestUrl"), result.requestUrl);
                value.insert(QStringLiteral("requestBody"), result.requestBody);
                value.insert(QStringLiteral("sessionBaseUrlNeedsVersion"),
                             result.sessionBaseUrlNeedsVersion);
                if (!result.suggestedBaseUrl.isEmpty()) {
                    value.insert(QStringLiteral("suggestedBaseUrl"), result.suggestedBaseUrl);
                }
                responder.resolve(value);
            });
    });
}
