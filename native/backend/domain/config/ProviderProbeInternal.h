#pragma once

#include "MainCopy.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QString>

#include <functional>

/**
 * Internals shared by the provider-probe translation units.
 *
 * `ProviderProbe.cpp` owns the public orchestration (ordered fallbacks, timeouts,
 * result shaping); the request builders/parsers and the baseUrl path rules live in
 * their own files so no single module has to hold the whole per-API matrix.
 * Nothing here is part of the channel surface - include ProviderProbe.h for that.
 */
namespace providerprobe {
namespace internal {

/** One prepared HTTP call: everything `send` needs, with the key already embedded. */
struct Request {
    QString url;
    QJsonObject headers;
    QByteArray body;
    bool post = false;
};

/** Transport outcome. `reached` means the server answered, not that it answered 2xx. */
struct HttpOutcome {
    bool reached = false;
    bool timedOut = false;
    int status = 0;
    QString statusText;
    QByteArray body;
    QString error;
};

/** Never let an API key leak into a diagnostic string. */
inline QString redact(const QString &value, const QString &apiKey)
{
    if (apiKey.isEmpty()) return value;
    QString result = value;
    result.replace(apiKey, QStringLiteral("***"));
    return result;
}

inline QString withTrailingSlashesRemoved(const QString &value)
{
    QString result = value;
    while (result.endsWith(QLatin1Char('/'))) result.chop(1);
    return result;
}

/** True when the baseUrl already ends in a version segment (`/v1`, `/v1beta`, `/api`). */
bool hasApiVersionPath(const QString &baseUrl);

/** Google endpoints always carry a version segment; default to `/v1beta`. */
QString googleVersionedBase(const QString &baseUrl);

/** Google model ids are addressed as `models/<id>`. */
QString googleModelPath(const QString &modelId);

/** One URL per API family; the list is tried in order until one answers. */
QList<Request> buildModelsRequests(const QString &baseUrl, const QString &apiKey,
                                   const QString &apiType);

/** The single minimal request that proves baseUrl + apiKey + model are usable. */
Request buildTestRequest(const QString &baseUrl, const QString &apiKey, const QString &modelId,
                         const QString &apiType, const QJsonObject &requestHeaders);

/** `{id, name}` entries from any of the supported model-list shapes. */
QJsonArray parseModelsResponse(const QJsonObject &body, const QString &apiType);

/** `{model, snippet, tokens}` from any of the supported chat/test response shapes. */
QJsonObject parseTestResponse(const QJsonObject &body, const QString &modelId, const QString &apiType,
                              const maincopy::Translator &translate);

/** One-shot request helper: owns the reply, applies the timeout and always settles. */
void send(const Request &request, int timeoutMs, std::function<void(const HttpOutcome &)> done);

} // namespace internal
} // namespace providerprobe
