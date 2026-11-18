#pragma once

#include <QJsonObject>
#include <QJsonValue>

struct ChannelServices;

namespace modelconfig {

/** Read the current model definitions before a validated config write. */
QJsonValue snapshot(const ChannelServices &services);
QJsonValue authSnapshot(const ChannelServices &services);

/** Reconcile explicit deletions, then invalidate the discovery cache and notify views. */
void saved(ChannelServices &services, const QJsonValue &previousModels,
           const QJsonValue &previousAuth = QJsonValue(QJsonValue::Undefined));

} // namespace modelconfig
