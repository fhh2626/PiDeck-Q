#pragma once

#include <QJsonObject>
#include <QString>
#include <functional>

class QUrl;
using NativeUrlOpener = std::function<bool(const QUrl &)>;

/** Reveal a file and report launch failures to the sidecar instead of swallowing them. */
QJsonObject revealNativeFile(const QString &path, const NativeUrlOpener &openUrl = {});

/** Recycle one entry; scoped authorization errors never permit permanent fallback. */
QJsonValue trashNativeItem(const QJsonObject &params);
