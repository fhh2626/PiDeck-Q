#pragma once

#include <QJsonObject>
#include <QString>

/** Reveal a file and report launch failures to the sidecar instead of swallowing them. */
QJsonObject revealNativeFile(const QString &path);

/** Recycle one entry; scoped authorization errors never permit permanent fallback. */
QJsonValue trashNativeItem(const QJsonObject &params);
