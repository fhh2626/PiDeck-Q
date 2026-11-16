#pragma once

#include <QJsonObject>
#include <QString>

/** Reveal a file and report launch failures to the sidecar instead of swallowing them. */
QJsonObject revealNativeFile(const QString &path);
