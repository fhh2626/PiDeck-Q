#pragma once

#include "ChannelContext.h"
#include "ChannelRegistry.h"
#include "HttpRequest.h"
#include "WebRoutes.h"

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

#include <functional>

/**
 * Shared plumbing for the LAN web route handlers.
 *
 * Kept separate from the route table so both route modules (general + session/runtime)
 * answer with the same error bodies and the same channel-invocation wrapper. There is
 * exactly one place that decides what a rejected channel looks like on the wire.
 */
namespace webdispatch {

struct Reply {
    int status = 200;
    QJsonValue body;
};

using Callback = std::function<void(Reply)>;

/**
 * `{code, error}` body, shaped like the oracle's `sendError(statusCode, code, error, params)`.
 *
 * `status` is accepted so a call site reads exactly like the oracle branch it mirrors;
 * the value that actually reaches the wire is `Reply::status`. `params` never appears
 * because no route parameterizes its copy.
 */
QJsonValue errorBody(int status, const QString &code, const QString &error);

/** 500 `webError.internal`: a domain failure is logged, never echoed to the browser. */
Reply internalError();

/** 400 with the oracle's code and its English copy. */
Reply badRequest(const QString &code);

/** `readJson`: an empty body is `{}`; malformed JSON is an internal failure (500). */
bool readJsonObject(const HttpRequest &request, QJsonObject *out);

/** Invoke a channel and answer its value verbatim. */
void invoke(ChannelRegistry &registry, const QString &channel, const QJsonArray &args,
            Callback callback);

/** Invoke a channel whose value becomes the body of `{key: value}`. */
void invokeInto(ChannelRegistry &registry, const QString &channel, const QJsonArray &args,
                const QString &key, Callback callback);

/** `Number.isSafeInteger`: integral and inside the JS safe range. */
bool isSafeInteger(double value);

enum class QueryState { Absent, Valid, Invalid };

/**
 * Strict optional integer query parameter.
 *
 * `Invalid` must become a 400: silently clamping (e.g. `turnCount=0` -> 50) would page
 * the browser back to the tail and duplicate history.
 */
QueryState optionalInteger(const HttpRequest &request, const QByteArray &name, double minimum,
                           double maximum, double *out);

/** The `target` the web client echoes back, validated against the path session id. */
QJsonValue validatedTarget(const QJsonObject &body, const QString &sessionId);

} // namespace webdispatch
