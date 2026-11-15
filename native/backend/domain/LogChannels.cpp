#include "ChannelContext.h"

#include "logs/AppLogStore.h"
#include "logs/RpcLogEntry.h"
#include "logs/RpcLogStore.h"

#include "HostRpcClient.h"

#include <QJsonObject>

/**
 * `logs:*`, `renderer-log` and `rpc-logs:*`.
 *
 * Port of the logging half of src/main/ipc/systemIpc.ts. The handlers are thin: the
 * query/paging rules live in `applog::Store` and the bounded history scan in
 * `rpclog::Store`, so both can be tested without the RPC surface.
 */
namespace {

applog::Store &appLog(const ChannelServices &services)
{
    if (!services.appLog) throw ChannelError(QStringLiteral("App logger is not available"));
    return *services.appLog;
}

rpclog::Store &rpcLog(const ChannelServices &services)
{
    if (!services.rpcLog) throw ChannelError(QStringLiteral("RPC logger is not available"));
    return *services.rpcLog;
}

/** `level` is renderer data: anything outside the enum degrades to `info`. */
QString safeLevel(const QString &level)
{
    static const QStringList allowed = {QStringLiteral("debug"), QStringLiteral("info"),
                                        QStringLiteral("warn"), QStringLiteral("error")};
    return allowed.contains(level) ? level : QStringLiteral("info");
}

} // namespace

void registerLogChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("logs:list"), [&services](const QJsonArray &args) {
        return QJsonValue(appLog(services).list(applog::parseQuery(channels::objectArg(args, 0))));
    });

    registry.add(QStringLiteral("logs:list-page"), [&services](const QJsonArray &args) {
        return QJsonValue(
            appLog(services).listPage(applog::parseQuery(channels::objectArg(args, 0))));
    });

    registry.add(QStringLiteral("renderer:log"), [&services](const QJsonArray &args) {
        const QString level = safeLevel(channels::stringArg(args, 0));
        const QString scope = channels::stringArg(args, 1);
        const QString message = channels::stringArg(args, 2);
        // An absent detail must stay absent: `QJsonValue()` is `null`, and writing
        // `detail: null` would differ from the oracle's omitted field. An explicit null
        // argument is still preserved.
        const QJsonValue detail = args.size() > 3 ? args.at(3) : QJsonValue(QJsonValue::Undefined);
        appLog(services).write(level, scope, message, detail);
        return QJsonValue(QJsonValue::Undefined);
    });

    registry.add(QStringLiteral("logs:clear"), [&services](const QJsonArray &) {
        appLog(services).clear();
        return QJsonValue(QJsonValue::Undefined);
    });

    registry.addAsync(QStringLiteral("logs:open-folder"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
                          appLog(services).ensureDirectory();
                          if (!services.host) {
                              responder.reject(QStringLiteral("Host bridge is not available"));
                              return;
                          }
                          auto request = services.host->request(
                              QStringLiteral("shell.openPath"),
                              QJsonObject{{QStringLiteral("path"), appLog(services).directory()}});
                          request->then([responder](const QJsonValue &) mutable {
                              responder.resolve(QJsonValue(QJsonValue::Undefined));
                          });
                          request->fail([responder](const QString &error) mutable {
                              responder.reject(error);
                          });
                      });

    registry.add(QStringLiteral("logs:get-size"), [&services](const QJsonArray &) {
        return QJsonValue(double(appLog(services).size()));
    });

    // ── RPC traffic log ────────────────────────────────────────────────
    registry.add(QStringLiteral("rpc-logs:get-size"), [&services](const QJsonArray &args) {
        // The optional first argument is a runtime target; only its agentId matters here.
        const QJsonObject target = channels::objectArg(args, 0);
        return QJsonValue(double(rpcLog(services).size(
            target.value(QStringLiteral("agentId")).toString())));
    });

    registry.add(QStringLiteral("rpc-logs:get"), [&services](const QJsonArray &args) {
        const QJsonObject options = channels::objectArg(args, 0);
        rpclog::HistoryOptions history;
        history.agentId = options.value(QStringLiteral("target")).toObject()
                              .value(QStringLiteral("agentId")).toString();
        if (options.value(QStringLiteral("days")).isDouble()) {
            history.days = options.value(QStringLiteral("days")).toInt(7);
        }
        if (options.value(QStringLiteral("limit")).isDouble()) {
            history.limit = options.value(QStringLiteral("limit")).toInt(5000);
        }
        return QJsonValue(rpcLog(services).history(history));
    });

    registry.add(QStringLiteral("rpc-logs:get-live"), [&services](const QJsonArray &args) {
        const QJsonValue agentId = channels::argAt(args, 0);
        return QJsonValue(rpcLog(services).live(agentId.isString() ? agentId.toString()
                                                                  : QString()));
    });

    registry.add(QStringLiteral("rpc-logs:save"), [&services](const QJsonArray &args) {
        const QJsonArray raw = channels::objectArg(args, 0).value(QStringLiteral("entries")).toArray();
        // Renderer data is untrusted: cap the batch and drop entries that are not
        // well-formed log records before touching the disk (oracle `isRpcLogEntry`).
        QJsonArray entries;
        for (int index = 0; index < raw.size() && index < 10'000; ++index) {
            const QJsonObject entry = raw.at(index).toObject();
            if (rpclog::isRendererEntry(entry)) entries.append(entry);
        }
        if (entries.isEmpty()) return QJsonValue(QJsonArray());
        QStringList written = rpcLog(services).appendEntries(entries);
        QJsonArray paths;
        for (const QString &path : written) paths.append(path);
        return QJsonValue(paths);
    });

    registry.add(QStringLiteral("rpc-logs:clear"), [&services](const QJsonArray &args) {
        const QJsonObject target = channels::objectArg(args, 0);
        rpcLog(services).clear(target.value(QStringLiteral("agentId")).toString());
        return QJsonValue(QJsonValue::Undefined);
    });

    registry.add(QStringLiteral("rpc-logs:logging-set"), [&services](const QJsonArray &args) {
        const QJsonObject target = channels::objectArg(args, 0);
        const QString agentId = target.value(QStringLiteral("agentId")).toString();
        if (agentId.isEmpty()) throw ChannelError(QStringLiteral("agentId is required"));
        const QJsonValue enabled = channels::argAt(args, 1);
        if (!enabled.isBool()) throw ChannelError(QStringLiteral("enabled must be a boolean."));
        rpcLog(services).setLoggingEnabled(agentId, enabled.toBool());
        return QJsonValue(enabled.toBool());
    });

    registry.add(QStringLiteral("rpc-logs:logging-get"), [&services](const QJsonArray &args) {
        const QJsonObject target = channels::objectArg(args, 0);
        const QString agentId = target.value(QStringLiteral("agentId")).toString();
        if (agentId.isEmpty()) throw ChannelError(QStringLiteral("agentId is required"));
        return QJsonValue(rpcLog(services).loggingEnabled(agentId));
    });
}
