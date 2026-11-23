#pragma once

#include "ChannelContext.h"

#include "BackgroundWork.h"

#include <QJsonArray>
#include <QJsonValue>
#include <QString>
#include <QStringList>

#include <exception>

/**
 * Shared helpers for the `files:*` and `dialog:*` channels.
 *
 * Split out of FileChannels.cpp so the read and mutation channel groups can share
 * input validation, localized copy and worker-thread settling without one oversized
 * translation unit.
 */
namespace filechannels {

/** Hard ceiling for reading a path that came from outside the authorized roots. */
constexpr qint64 kMaxExternalReadBytes = 10 * 1024 * 1024;

QString language(const ChannelServices &services);
QString localized(const ChannelServices &services, const QString &key);

/** Settle a channel from a worker-thread outcome. */
void settle(ChannelResponder responder, const background::Outcome &outcome);

/** Map an internal fsops error code onto the localized message the renderer shows. */
QString localizeFsError(const ChannelServices &services, const std::exception &error);

void assertString(const QJsonValue &value, const QString &field);
QStringList assertStringArray(const QJsonValue &value, const QString &field);
qint64 optionalMaxBytes(const QJsonArray &args, int index);

/** Copy every source into `targetDir`, auto-renaming on conflict. */
QJsonValue copySources(const ChannelServices &services, const QStringList &sourcePaths, const QString &targetDir);

} // namespace filechannels
