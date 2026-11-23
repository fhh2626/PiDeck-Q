#pragma once

#include "ChannelContext.h"
#include "ChannelRegistry.h"
#include "HttpRequest.h"
#include "WebRoutes.h"
#include "WebSupport.h"

#include <QJsonValue>
#include <QString>

/**
 * HTTP -> domain dispatch for the LAN web service.
 *
 * Every business route is answered by invoking the *same* `ChannelRegistry` channel the
 * desktop renderer uses, so the web client cannot observe a second catalog, a second
 * runtime owner or a looser validator. Routes with no channel counterpart (the `/api/state`
 * composition) read the shared owners directly, exactly like the oracle's `deps` object.
 *
 * The reply is always JSON: browser assets are served by the transport, not here.
 */
namespace webdispatch {

struct Context {
    QString host;
    int port = 0;
};

/**
 * Answer one routed request. `callback` runs exactly once, possibly asynchronously.
 *
 * A channel rejection becomes a generic 500 (`webError.internal`), matching the oracle:
 * domain failures are logged, not echoed to a LAN client.
 */
void handle(const webroute::Match &match, const HttpRequest &request, const Context &context,
            ChannelServices &services, ChannelRegistry &registry, Callback callback);

} // namespace webdispatch
