#pragma once

#include "MainCopy.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

#include <functional>

/**
 * Provider connectivity probes: "fetch model list" and "test connection".
 *
 * Port of ConfigManager's `fetchProviderModels` / `testProviderConnection` plus the
 * baseUrl path rules in config/baseUrlPath.ts.
 *
 * Both probes are pure network calls with no persisted state, so they run off the event
 * loop and settle through a callback. The API key never appears in a returned URL or
 * body: every diagnostic string is redacted before it leaves this module.
 */
namespace providerprobe {

struct ModelsResult {
    bool success = false;
    QJsonArray models;
    QString error;
    QString debugDetails;
    QString requestUrl;
    bool sessionBaseUrlNeedsVersion = false;
    QString suggestedBaseUrl;
};

struct TestResult {
    bool success = false;
    QString model;
    QString snippet;
    QJsonObject tokens;
    qint64 latencyMs = 0;
    QString error;
    QString requestUrl;
    QString requestBody;
    QString debugDetails;
    bool sessionBaseUrlNeedsVersion = false;
    QString suggestedBaseUrl;
};

/** `GET /models` (with the per-API fallback path) and normalize the response. */
void fetchModels(const QString &baseUrl, const QString &apiKey, const QString &apiType,
                 const maincopy::Translator &translate,
                 std::function<void(const ModelsResult &)> done);

/** One minimal chat request that proves baseUrl + apiKey + model are usable. */
void testConnection(const QString &baseUrl, const QString &apiKey, const QString &modelId,
                    const QString &apiType, const QJsonObject &extraHeaders,
                    const maincopy::Translator &translate,
                    std::function<void(const TestResult &)> done);

/** `ensureOpenAiVersionPath`: append `/v1` unless a version segment is already present. */
QString ensureVersionPath(const QString &baseUrl);

/** `needsSessionBaseUrlVersionHint` (see config/baseUrlPath.ts). */
bool needsSessionBaseUrlVersion(const QString &configuredBaseUrl, const QString &effectiveRequestUrl);

/** `suggestNormalizedBaseUrl`: the baseUrl that should be persisted, or empty. */
QString suggestNormalizedBaseUrl(const QString &configuredBaseUrl, const QString &effectiveRequestUrl,
                                 const QString &apiType);

} // namespace providerprobe
