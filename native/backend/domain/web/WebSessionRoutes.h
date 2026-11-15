#pragma once

#include "ChannelContext.h"
#include "HttpRequest.h"
#include "WebDispatch.h"
#include "WebRoutes.h"

/**
 * Session-record and runtime-action routes.
 *
 * Split from WebDispatch so each file owns one route family: this one carries the
 * `:id/(update|delete|copy|export-html)` and `:id/runtime/:action` mappings, including the
 * "running session cannot be deleted is a 400, not a broken service" split that the
 * oracle gets from a distinct exception type.
 */
namespace webdispatch {

/** `POST /api/sessions/:id/(update|delete|copy|export-html)`. */
void handleSessionRecord(const webroute::Match &match, const HttpRequest &request,
                         ChannelServices &services, ChannelRegistry &registry, Callback callback);

/** `POST /api/sessions/:id/runtime/:action`. */
void handleRuntimeAction(const webroute::Match &match, const HttpRequest &request,
                         ChannelServices &services, ChannelRegistry &registry, Callback callback);

} // namespace webdispatch
