#pragma once

#include <QJsonObject>
#include <QString>

/**
 * One `agents:rpc-log` record: the summary line and the raw frame.
 *
 * Port of the `piProcess.on("rpc-log", ...)` handler in `AgentManager.ts` plus the
 * `RpcLogEntry` shape in `shared/types/rpcLog.ts`. The summary is what the viewer's
 * list rows show; `data` keeps the full frame so the row can expand into pretty JSON.
 *
 * Invariants (asserted against the Node oracle by `native2LogsParity`):
 *  - the summary text is byte-identical for the same frame, including the `→`/`←`
 *    arrows, the `✓`/`✗` marks and the 60-character prompt/bash previews;
 *  - `data` is the frame as it crossed the pipe (no truncation): the 4 KiB cap is a
 *    property of the in-memory ring (`Store::live`), not of the record.
 */
namespace rpclog {

/** `direction` is `send` (desktop → pi) or `recv` (pi response/event). */
QString summaryFor(const QString &direction, const QJsonObject &data);

/** Full record; `id` is required so disk de-duplication and the viewer can merge. */
QJsonObject makeEntry(const QString &agentId, const QString &direction, const QJsonObject &data,
                      qint64 timeMs, const QString &id);

/** Random (UUID v4, no braces) id, same format as Node's `randomUUID()`. */
QString newEntryId();

/**
 * Renderer-supplied record (oracle `isRpcLogEntry`): stricter than the disk validator.
 *
 * `rpc-logs:save` receives untrusted objects, and the oracle drops anything whose
 * `direction` is not exactly `send`/`recv` before touching the disk. History reads keep
 * the looser disk validator so older rows are never hidden.
 */
bool isRendererEntry(const QJsonObject &entry);

} // namespace rpclog
