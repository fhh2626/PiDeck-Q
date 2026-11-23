#pragma once

#include <QString>
#include <QStringList>

struct ChannelServices;

/**
 * The pi search path (port of `PiLocator.getSearchDirs`).
 *
 * Split out of `PiLocator` because the list itself is a contract: `pi:check` returns it
 * to the renderer so a user can see *where* the desktop looked for pi. It must stay
 * identical to the Node order — process PATH first, then the package-manager directories
 * a desktop launch does not inherit — and every entry is deduplicated without reordering.
 */
namespace pilocator {

/** Node-style `join`: native separators, normalized, empty parent yields the child. */
QString joinPath(const QString &parent, const QString &child);

/** Every directory the locator searches, in the oracle's order (duplicates removed). */
QStringList searchDirs(const ChannelServices &services);

} // namespace pilocator
