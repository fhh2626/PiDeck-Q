#pragma once

#include <QList>
#include <QStringList>
#include <QUrl>

namespace NativeFilePathLimits {
inline constexpr qsizetype kMaxFilePathUtf8Bytes = 4 * 1024 * 1024;
inline constexpr int kMaxFilePathCount = 128;

/** Keeps native clipboard/drop path payloads below the host frame budget. */
inline bool append(QStringList &paths, const QString &path, qsizetype &totalBytes)
{
    if (path.isEmpty() || paths.size() >= kMaxFilePathCount) return false;
    const qsizetype bytes = path.toUtf8().size();
    if (bytes > kMaxFilePathUtf8Bytes - totalBytes) return false;
    paths.append(path);
    totalBytes += bytes;
    return true;
}

inline QStringList fromUrls(const QList<QUrl> &urls)
{
    QStringList paths;
    qsizetype totalBytes = 0;
    for (const QUrl &url : urls) {
        if (!url.isLocalFile()) continue;
        const QString path = url.toLocalFile();
        if (path.isEmpty()) continue;
        if (!append(paths, path, totalBytes)) break;
    }
    return paths;
}
}
