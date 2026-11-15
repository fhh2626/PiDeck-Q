#include "ProviderProbe.h"

#include "ConfigFiles.h"
#include "ProviderProbeInternal.h"

#include <memory>

#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>

namespace providerprobe {
namespace {

using internal::HttpOutcome;
using internal::Request;

constexpr int kModelsTimeoutMs = 10'000;
/** Reasoning gateways can be slow on the first packet; the copy says so explicitly. */
constexpr int kTestTimeoutMs = 45'000;

/** Shared state for the ordered model-list attempts (no self-referencing lambda cycle). */
struct FetchState {
    QString baseUrl;
    QString apiKey;
    QString apiType;
    maincopy::Translator translate;
    QList<Request> requests;
    int index = 0;
    QString lastError;
    QString lastDebug;
    QString lastUrl;
    std::function<void(const ModelsResult &)> done;
};

void attemptFetch(std::shared_ptr<FetchState> state)
{
    if (state->index >= state->requests.size()) {
        ModelsResult result;
        result.error = state->lastError.isEmpty()
            ? state->translate(QStringLiteral("mainConfig.fetchModelsFailed"), {})
            : state->lastError;
        result.debugDetails = state->lastDebug;
        result.requestUrl = state->lastUrl;
        result.sessionBaseUrlNeedsVersion =
            needsSessionBaseUrlVersion(state->baseUrl, state->lastUrl);
        return state->done(result);
    }
    const Request request = state->requests.at(state->index++);
    state->lastUrl = internal::redact(request.url, state->apiKey);
    internal::send(request, kModelsTimeoutMs, [state, request](const HttpOutcome &outcome) {
        if (!outcome.reached) {
            // A timeout and a refused connection read differently to the user.
            state->lastError = outcome.timedOut
                ? state->translate(QStringLiteral("mainConfig.fetchTimeout"), {})
                : state->translate(QStringLiteral("mainConfig.fetchModelsFailed"), {});
            return attemptFetch(state);
        }
        if (outcome.status < 200 || outcome.status >= 300) {
            state->lastDebug = QStringLiteral("HTTP %1: %2").arg(outcome.status).arg(outcome.statusText);
            state->lastError = state->translate(QStringLiteral("mainConfig.fetchModelsFailed"), {});
            return attemptFetch(state);
        }
        const QJsonArray models = internal::parseModelsResponse(
            QJsonDocument::fromJson(outcome.body).object(), state->apiType);
        if (models.isEmpty()) {
            state->lastError = state->translate(QStringLiteral("mainConfig.emptyModelList"), {});
            return attemptFetch(state);
        }
        ModelsResult result;
        result.success = true;
        result.models = models;
        result.requestUrl = state->lastUrl;
        result.sessionBaseUrlNeedsVersion =
            needsSessionBaseUrlVersion(state->baseUrl, request.url);
        result.suggestedBaseUrl = suggestNormalizedBaseUrl(state->baseUrl, request.url, state->apiType);
        state->done(result);
    });
}

} // namespace

void fetchModels(const QString &baseUrl, const QString &apiKey, const QString &apiType,
                 const maincopy::Translator &translate,
                 std::function<void(const ModelsResult &)> done)
{
    auto state = std::make_shared<FetchState>();
    state->baseUrl = baseUrl;
    state->apiKey = apiKey;
    state->apiType = apiType;
    state->translate = translate;
    state->requests = internal::buildModelsRequests(baseUrl, apiKey, apiType);
    state->done = std::move(done);
    attemptFetch(state);
}

void testConnection(const QString &baseUrl, const QString &apiKey, const QString &modelId,
                    const QString &apiType, const QJsonObject &extraHeaders,
                    const maincopy::Translator &translate,
                    std::function<void(const TestResult &)> done)
{
    const QString api = configfiles::normalizeApiType(apiType);
    const Request request = internal::buildTestRequest(baseUrl, apiKey, modelId, api, extraHeaders);
    const qint64 startedAt = QDateTime::currentMSecsSinceEpoch();
    const QString safeUrl = internal::redact(request.url, apiKey);
    const QString safeBody = internal::redact(QString::fromUtf8(request.body), apiKey);
    const bool needsVersion = needsSessionBaseUrlVersion(baseUrl, request.url);
    const QString suggested = suggestNormalizedBaseUrl(baseUrl, request.url, api);

    internal::send(request, kTestTimeoutMs,
                   [apiKey, modelId, api, startedAt, safeUrl, safeBody, needsVersion, suggested,
                    translate, done](const HttpOutcome &outcome) {
        TestResult result;
        result.latencyMs = QDateTime::currentMSecsSinceEpoch() - startedAt;
        result.requestUrl = safeUrl;
        result.requestBody = safeBody;
        result.sessionBaseUrlNeedsVersion = needsVersion;
        if (!outcome.reached) {
            result.error = outcome.timedOut
                ? translate(QStringLiteral("mainConfig.providerTestTimeout"), {})
                : translate(QStringLiteral("mainConfig.providerTestFailed"), {});
            return done(result);
        }
        if (outcome.status < 200 || outcome.status >= 300) {
            QString detail = QStringLiteral("%1 %2").arg(outcome.status).arg(outcome.statusText);
            const QJsonObject errorBody = QJsonDocument::fromJson(outcome.body).object();
            const QString message = errorBody.value(QStringLiteral("error"))
                                        .toObject()
                                        .value(QStringLiteral("message"))
                                        .toString();
            const QString fallback = errorBody.value(QStringLiteral("message")).toString();
            if (!message.isEmpty()) detail += QStringLiteral(" — ") + message;
            else if (!fallback.isEmpty()) detail += QStringLiteral(" — ") + fallback;
            result.error = translate(QStringLiteral("mainConfig.providerTestFailed"), {});
            result.debugDetails = internal::redact(detail, apiKey);
            return done(result);
        }
        const QJsonObject parsed = internal::parseTestResponse(
            QJsonDocument::fromJson(outcome.body).object(), modelId, api, translate);
        result.success = true;
        result.model = parsed.value(QStringLiteral("model")).toString();
        result.snippet = parsed.value(QStringLiteral("snippet")).toString();
        result.tokens = parsed.value(QStringLiteral("tokens")).toObject();
        result.suggestedBaseUrl = suggested;
        done(result);
    });
}

} // namespace providerprobe
