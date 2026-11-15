#include "ProviderProbeInternal.h"

#include "ConfigFiles.h"
#include "ProviderProbe.h"

#include <QJsonDocument>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QTimer>
#include <QUrl>
#include <QUrlQuery>

namespace providerprobe {
namespace internal {
namespace {

QJsonObject withSdkUserAgent(const QJsonObject &headers, const QString &userAgent)
{
    for (auto iterator = headers.begin(); iterator != headers.end(); ++iterator) {
        if (iterator.key().compare(QStringLiteral("user-agent"), Qt::CaseInsensitive) == 0) {
            return headers;
        }
    }
    QJsonObject result = headers;
    result.insert(QStringLiteral("User-Agent"), userAgent);
    return result;
}

QJsonObject normalizeRequestHeaders(const QJsonObject &headers)
{
    QJsonObject result;
    for (auto iterator = headers.begin(); iterator != headers.end(); ++iterator) {
        if (iterator.key().trimmed().isEmpty() || !iterator.value().isString()) continue;
        result.insert(iterator.key(), iterator.value());
    }
    return result;
}

QJsonObject openAiHeaders(const QString &apiKey)
{
    return withSdkUserAgent(
        QJsonObject{{QStringLiteral("Authorization"), QStringLiteral("Bearer ") + apiKey},
                    {QStringLiteral("Content-Type"), QStringLiteral("application/json")}},
        QStringLiteral("OpenAI/JS 6.26.0"));
}

QJsonObject anthropicHeaders(const QString &apiKey)
{
    return withSdkUserAgent(
        QJsonObject{{QStringLiteral("x-api-key"), apiKey},
                    {QStringLiteral("anthropic-version"), QStringLiteral("2023-06-01")},
                    {QStringLiteral("Content-Type"), QStringLiteral("application/json")}},
        QStringLiteral("anthropic-sdk-typescript/0.27.3"));
}

QByteArray compactJson(const QJsonObject &body)
{
    return QJsonDocument(body).toJson(QJsonDocument::Compact);
}

} // namespace

QList<Request> buildModelsRequests(const QString &baseUrl, const QString &apiKey, const QString &apiType)
{
    const QString api = configfiles::normalizeApiType(apiType);
    const QString key = QString::fromUtf8(QUrl::toPercentEncoding(apiKey));
    if (api == QStringLiteral("google-generative-ai")) {
        return {Request{googleVersionedBase(baseUrl) + QStringLiteral("/models?key=") + key,
                        QJsonObject{{QStringLiteral("Content-Type"), QStringLiteral("application/json")}},
                        {}, false}};
    }
    if (api == QStringLiteral("anthropic-messages")) {
        const QString trimmed = withTrailingSlashesRemoved(baseUrl);
        QString root = trimmed;
        if (root.endsWith(QStringLiteral("/v1"))) root.chop(3);
        const QJsonObject headers = anthropicHeaders(apiKey);
        const QString primary = root + QStringLiteral("/v1/models");
        const QString fallback = root + QStringLiteral("/models");
        if (primary == fallback) return {Request{primary, headers, {}, false}};
        return {Request{primary, headers, {}, false}, Request{fallback, headers, {}, false}};
    }
    // OpenAI-compatible families all expose GET /v1/models.
    const QJsonObject headers = openAiHeaders(apiKey);
    const QString primary = ensureVersionPath(baseUrl) + QStringLiteral("/models");
    const QString fallback = withTrailingSlashesRemoved(baseUrl) + QStringLiteral("/models");
    if (primary == fallback) return {Request{primary, headers, {}, false}};
    return {Request{primary, headers, {}, false}, Request{fallback, headers, {}, false}};
}

Request buildTestRequest(const QString &baseUrl, const QString &apiKey, const QString &modelId,
                         const QString &apiType, const QJsonObject &requestHeaders)
{
    const QString api = configfiles::normalizeApiType(apiType);
    const QJsonObject extra = normalizeRequestHeaders(requestHeaders);
    auto merge = [&extra](QJsonObject base) {
        for (auto iterator = extra.begin(); iterator != extra.end(); ++iterator) {
            base.insert(iterator.key(), iterator.value());
        }
        return base;
    };
    const QString key = QString::fromUtf8(QUrl::toPercentEncoding(apiKey));

    if (api == QStringLiteral("openai-responses") || api == QStringLiteral("openai-codex-responses")) {
        const QJsonObject body{
            {QStringLiteral("model"), modelId},
            // A one-token probe proves reachability without paying for reasoning.
            {QStringLiteral("input"), QStringLiteral("Hi")},
            {QStringLiteral("max_output_tokens"), 1},
        };
        return Request{ensureVersionPath(baseUrl) + QStringLiteral("/responses"),
                       withSdkUserAgent(merge(openAiHeaders(apiKey)), QStringLiteral("OpenAI/JS 6.26.0")),
                       compactJson(body), true};
    }
    if (api == QStringLiteral("anthropic-messages")) {
        const QJsonObject body{
            {QStringLiteral("model"), modelId},
            {QStringLiteral("messages"),
             QJsonArray{QJsonObject{{QStringLiteral("role"), QStringLiteral("user")},
                                    {QStringLiteral("content"), QStringLiteral("Hi")}}}},
            // Some proxies and Claude models reject a max_tokens below 10.
            {QStringLiteral("max_tokens"), 10},
        };
        return Request{ensureVersionPath(baseUrl) + QStringLiteral("/messages"),
                       withSdkUserAgent(merge(anthropicHeaders(apiKey)),
                                        QStringLiteral("anthropic-sdk-typescript/0.27.3")),
                       compactJson(body), true};
    }
    if (api == QStringLiteral("google-generative-ai")) {
        const QJsonObject body{
            {QStringLiteral("contents"),
             QJsonArray{QJsonObject{
                 {QStringLiteral("role"), QStringLiteral("user")},
                 {QStringLiteral("parts"), QJsonArray{QJsonObject{{QStringLiteral("text"), QStringLiteral("Hi")}}}}}}},
            {QStringLiteral("generationConfig"), QJsonObject{{QStringLiteral("maxOutputTokens"), 1}}},
        };
        return Request{googleVersionedBase(baseUrl) + QLatin1Char('/') + googleModelPath(modelId)
                           + QStringLiteral(":generateContent?key=") + key,
                       merge(QJsonObject{{QStringLiteral("Content-Type"), QStringLiteral("application/json")}}),
                       compactJson(body), true};
    }
    if (api == QStringLiteral("mistral-conversations")) {
        const QJsonObject body{
            {QStringLiteral("model"), modelId},
            {QStringLiteral("inputs"), QStringLiteral("Hi")},
            {QStringLiteral("store"), false},
        };
        return Request{withTrailingSlashesRemoved(baseUrl) + QStringLiteral("/conversations"),
                       merge(QJsonObject{
                           {QStringLiteral("Authorization"), QStringLiteral("Bearer ") + apiKey},
                           {QStringLiteral("Content-Type"), QStringLiteral("application/json")}}),
                       compactJson(body), true};
    }
    const QJsonObject body{
        {QStringLiteral("model"), modelId},
        {QStringLiteral("messages"),
         QJsonArray{QJsonObject{{QStringLiteral("role"), QStringLiteral("user")},
                                {QStringLiteral("content"), QStringLiteral("Hi")}}}},
        {QStringLiteral("max_tokens"), 1},
    };
    return Request{ensureVersionPath(baseUrl) + QStringLiteral("/chat/completions"),
                   merge(QJsonObject{{QStringLiteral("Authorization"), QStringLiteral("Bearer ") + apiKey},
                                     {QStringLiteral("Content-Type"), QStringLiteral("application/json")}}),
                   compactJson(body), true};
}

QJsonArray parseModelsResponse(const QJsonObject &body, const QString &apiType)
{
    const QString api = configfiles::normalizeApiType(apiType);
    QJsonArray raw;
    if (body.value(QStringLiteral("data")).isArray()) raw = body.value(QStringLiteral("data")).toArray();
    else if (body.value(QStringLiteral("models")).isArray()) raw = body.value(QStringLiteral("models")).toArray();
    QJsonArray models;
    for (const QJsonValue &value : raw) {
        const QJsonObject model = value.toObject();
        QString id = model.value(QStringLiteral("id")).toString();
        if (id.isEmpty()) id = model.value(QStringLiteral("name")).toString();
        if (api == QStringLiteral("google-generative-ai") && id.startsWith(QStringLiteral("models/"))) {
            id = id.mid(7);
        }
        if (id.isEmpty()) continue;
        QString name = model.value(QStringLiteral("displayName")).toString();
        if (name.isEmpty()) {
            name = model.value(QStringLiteral("name")).toString();
            if (name.startsWith(QStringLiteral("models/"))) name = name.mid(7);
        }
        if (name.isEmpty()) name = id;
        models.append(QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("name"), name}});
    }
    return models;
}

QJsonObject parseTestResponse(const QJsonObject &body, const QString &modelId, const QString &apiType,
                              const maincopy::Translator &t)
{
    const QString api = configfiles::normalizeApiType(apiType);
    const QString empty = t(QStringLiteral("mainConfig.emptyResponse"), {});
    QJsonObject result;
    QJsonObject tokens;

    const auto firstText = [](const QJsonArray &array) {
        return array.isEmpty() ? QString() : array.at(0).toObject().value(QStringLiteral("text")).toString();
    };
    const auto setUsage = [&tokens](const QJsonObject &usage, const QString &inputKey,
                                    const QString &outputKey) {
        if (usage.contains(inputKey)) tokens.insert(QStringLiteral("input"), usage.value(inputKey));
        if (usage.contains(outputKey)) tokens.insert(QStringLiteral("output"), usage.value(outputKey));
    };

    if (api == QStringLiteral("openai-responses") || api == QStringLiteral("openai-codex-responses")) {
        const QJsonArray output = body.value(QStringLiteral("output")).toArray();
        QString text;
        if (!output.isEmpty()) {
            text = firstText(output.at(0).toObject().value(QStringLiteral("content")).toArray());
        }
        if (text.isEmpty()) {
            for (const QJsonValue &value : output) {
                const QJsonObject item = value.toObject();
                if (item.value(QStringLiteral("type")).toString() != QStringLiteral("function_call")) continue;
                // A tool-call-only reply still proves the endpoint works.
                text = t(QStringLiteral("mainConfig.toolCompatibility"),
                         QJsonObject{{QStringLiteral("name"),
                                      item.value(QStringLiteral("name")).toString(
                                          QStringLiteral("function_call"))}});
                break;
            }
        }
        if (text.isEmpty()) text = empty;
        setUsage(body.value(QStringLiteral("usage")).toObject(), QStringLiteral("input_tokens"),
                 QStringLiteral("output_tokens"));
        result.insert(QStringLiteral("model"), body.value(QStringLiteral("model")).toString(modelId));
        result.insert(QStringLiteral("snippet"), text);
        result.insert(QStringLiteral("tokens"), tokens);
        return result;
    }
    if (api == QStringLiteral("anthropic-messages")) {
        const QString text = firstText(body.value(QStringLiteral("content")).toArray());
        setUsage(body.value(QStringLiteral("usage")).toObject(), QStringLiteral("input_tokens"),
                 QStringLiteral("output_tokens"));
        result.insert(QStringLiteral("model"), body.value(QStringLiteral("model")).toString(modelId));
        result.insert(QStringLiteral("snippet"), text.isEmpty() ? empty : text);
        result.insert(QStringLiteral("tokens"), tokens);
        return result;
    }
    if (api == QStringLiteral("google-generative-ai")) {
        const QJsonArray candidates = body.value(QStringLiteral("candidates")).toArray();
        QString text;
        if (!candidates.isEmpty()) {
            const QJsonObject content = candidates.at(0).toObject().value(QStringLiteral("content")).toObject();
            text = firstText(content.value(QStringLiteral("parts")).toArray());
        }
        setUsage(body.value(QStringLiteral("usageMetadata")).toObject(),
                 QStringLiteral("promptTokenCount"), QStringLiteral("candidatesTokenCount"));
        result.insert(QStringLiteral("model"),
                      body.value(QStringLiteral("modelVersion")).toString(modelId));
        result.insert(QStringLiteral("snippet"), text.isEmpty() ? empty : text);
        result.insert(QStringLiteral("tokens"), tokens);
        return result;
    }
    if (api == QStringLiteral("mistral-conversations")) {
        const QJsonArray outputs = body.value(QStringLiteral("outputs")).toArray();
        QString text;
        if (!outputs.isEmpty()) {
            const QJsonValue content = outputs.at(0).toObject().value(QStringLiteral("content"));
            if (content.isArray()) {
                QStringList parts;
                for (const QJsonValue &item : content.toArray()) {
                    const QString part = item.isObject()
                        ? item.toObject().value(QStringLiteral("text")).toString()
                        : item.toString();
                    if (!part.isEmpty()) parts.append(part);
                }
                text = parts.join(QLatin1Char(' '));
            } else if (content.isString()) {
                text = content.toString();
            }
        }
        if (text.isEmpty()) text = body.value(QStringLiteral("response")).toString();
        setUsage(body.value(QStringLiteral("usage")).toObject(), QStringLiteral("prompt_tokens"),
                 QStringLiteral("completion_tokens"));
        result.insert(QStringLiteral("model"), body.value(QStringLiteral("model")).toString(modelId));
        result.insert(QStringLiteral("snippet"), text.isEmpty() ? empty : text);
        result.insert(QStringLiteral("tokens"), tokens);
        return result;
    }
    // openai-completions (the default family).
    const QJsonArray choices = body.value(QStringLiteral("choices")).toArray();
    QString text;
    if (!choices.isEmpty()) {
        text = choices.at(0).toObject().value(QStringLiteral("message")).toObject()
                   .value(QStringLiteral("content")).toString();
        if (text.isEmpty()) {
            text = choices.at(0).toObject().value(QStringLiteral("text")).toString();
        }
    }
    setUsage(body.value(QStringLiteral("usage")).toObject(), QStringLiteral("prompt_tokens"),
             QStringLiteral("completion_tokens"));
    result.insert(QStringLiteral("model"), body.value(QStringLiteral("model")).toString(modelId));
    result.insert(QStringLiteral("snippet"), text.isEmpty() ? empty : text);
    result.insert(QStringLiteral("tokens"), tokens);
    return result;
}

void send(const Request &request, int timeoutMs, std::function<void(const HttpOutcome &)> done)
{
    auto *manager = new QNetworkAccessManager();
    QNetworkRequest networkRequest{QUrl(request.url)};
    for (auto iterator = request.headers.begin(); iterator != request.headers.end(); ++iterator) {
        networkRequest.setRawHeader(iterator.key().toUtf8(), iterator.value().toString().toUtf8());
    }
    QNetworkReply *reply = request.post
        ? manager->post(networkRequest, request.body)
        : manager->get(networkRequest);
    auto *timedOut = new bool(false);
    QTimer *timer = new QTimer(reply);
    timer->setSingleShot(true);
    QObject::connect(timer, &QTimer::timeout, reply, [reply, timedOut]() {
        *timedOut = true;
        reply->abort();
    });
    timer->start(timeoutMs);
    QObject::connect(reply, &QNetworkReply::finished, reply,
                     [manager, reply, timedOut, done]() {
        HttpOutcome outcome;
        outcome.timedOut = *timedOut;
        delete timedOut;
        outcome.status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        outcome.statusText = reply->attribute(QNetworkRequest::HttpReasonPhraseAttribute).toString();
        outcome.body = reply->readAll();
        // A reachable server always yields a status code, even for 4xx/5xx.
        outcome.reached = outcome.status > 0;
        if (!outcome.reached) outcome.error = reply->errorString();
        reply->deleteLater();
        manager->deleteLater();
        done(outcome);
    });
}

} // namespace internal
} // namespace providerprobe
