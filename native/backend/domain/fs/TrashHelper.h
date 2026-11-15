#pragma once

#include <QString>
#include <QStringList>

#include <functional>

class HostRpcClient;

/**
 * Recycle-bin deletion through the native host.
 *
 * Every user-initiated deletion goes through `shell.trashItem` so it stays
 * recoverable; the backend never unlinks user content. The host call is asynchronous,
 * so multi-path deletions are sequenced here and settle exactly once.
 */
namespace trashhelper {

using Done = std::function<void(bool ok, const QString &error)>;

/** Move `paths` to the recycle bin one at a time, then report the first failure. */
void trashAll(HostRpcClient *host, const QStringList &paths, Done done);

} // namespace trashhelper
