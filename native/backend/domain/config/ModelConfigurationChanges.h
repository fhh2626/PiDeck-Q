#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

struct ChannelServices;

namespace modelconfig {

/** Identity of the configuration directory currently published to the settings editor. */
struct Scope {
    QString environment = QStringLiteral("native");
    QString wslDistro;
    QString wslUser;
};

Scope activeScope(const ChannelServices &services);

/** Read the current model definitions before a validated config write. */
QJsonValue snapshot(const ChannelServices &services);

/** Reconcile explicit deletions, then invalidate the discovery cache and notify views. */
void saved(ChannelServices &services, const QJsonValue &previousModels);

} // namespace modelconfig
