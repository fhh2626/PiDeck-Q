#pragma once

#include "ChannelContext.h"

#include <QJsonObject>

/**
 * `GET /api/state`: the one snapshot the browser renders on load.
 *
 * Port of `WebServiceManager.getState()`. The web page has no nested session tree, so
 * internal worker/reviewer sessions and their runtimes, messages and pending requests
 * are filtered out — a LAN client must not be able to read another session's worker
 * output just because its catalog record exists.
 */
namespace webstate {

/**
 * Build the snapshot from the same owners the desktop uses.
 *
 * Reads the catalog, project store and runtime coordinator; never mutates state and
 * never spawns pi.
 */
QJsonObject build(const ChannelServices &services);

} // namespace webstate
