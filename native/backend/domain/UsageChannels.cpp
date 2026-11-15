#include "ChannelContext.h"

#include "usage/UsageService.h"

#include <QJsonObject>

/**
 * `usage-stats:*`.
 *
 * Port of src/main/ipc/usageStatsIpc.ts. The handlers stay thin: parsing, the
 * incremental cursor and the aggregation all live in `usage::Service`, so the
 * behaviour can be tested without the RPC surface.
 *
 * A missing `analytics/usage.jsonl` means "pi-tracker is not installed" and is
 * reported as data, never as an error. Genuine IO failures propagate as structured
 * errors so the renderer can show an error state instead of an empty chart.
 */
namespace {

usage::Service &service(const ChannelServices &services)
{
    if (!services.usageStats) {
        throw ChannelError(QStringLiteral("Usage stats service is not available"));
    }
    return *services.usageStats;
}

} // namespace

void registerUsageChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("usage-stats:detect"), [&services](const QJsonArray &) {
        return QJsonValue(service(services).detect());
    });

    registry.add(QStringLiteral("usage-stats:refresh"), [&services](const QJsonArray &) {
        return QJsonValue(service(services).refresh());
    });

    registry.add(QStringLiteral("usage-stats:get"), [&services](const QJsonArray &) {
        const QJsonObject view = service(services).getAggregated();
        // `null` is a meaningful answer: no log file, so the renderer shows the
        // "install pi-tracker" state rather than an empty dashboard.
        return QJsonValue(view.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(view));
    });
}
