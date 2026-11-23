#include "WebAssets.h"

#include "StaticFiles.h"

#include <QDir>
#include <QFileInfo>

namespace webassets {
namespace {

bool hasExtension(const QString &path)
{
    const QString name = QFileInfo(path).fileName();
    // A leading dot (".well-known") is a directory-ish path, not an extension.
    return name.lastIndexOf(QLatin1Char('.')) > 0;
}

bool isResourceRequest(const QString &path)
{
    return hasExtension(path) && !path.endsWith(QLatin1String(".html"), Qt::CaseInsensitive);
}

} // namespace

Resolution resolve(const QString &root, const QByteArray &decodedPath)
{
    Resolution result;
    QString requested = QString::fromUtf8(decodedPath);
    if (requested.isEmpty()) requested = QStringLiteral("/");

    const QString canonicalRoot = QFileInfo(root).canonicalFilePath();
    const bool resource = isResourceRequest(requested);

    QString relative;
    if (requested == QLatin1String("/") || !hasExtension(requested)) {
        // Root and client-side routes both land on the web entry document.
        const QString webEntry = QDir(canonicalRoot).filePath(QStringLiteral("web.html"));
        relative = QFileInfo::exists(webEntry) ? QStringLiteral("web.html")
                                               : QStringLiteral("index.html");
    } else {
        relative = requested;
        while (relative.startsWith(QLatin1Char('/'))) relative.remove(0, 1);
    }

    if (canonicalRoot.isEmpty()) {
        result.kind = resource ? Kind::NotFound : Kind::Fallback;
        return result;
    }
    const QString candidate = QDir::cleanPath(QDir(canonicalRoot).filePath(relative));
    if (!staticfiles::isInsideRoot(canonicalRoot, candidate)) {
        result.kind = Kind::Forbidden;
        return result;
    }
    const QFileInfo info(candidate);
    if (!info.isFile()) {
        result.kind = resource ? Kind::NotFound : Kind::Fallback;
        return result;
    }
    result.kind = Kind::File;
    result.path = candidate;
    return result;
}

QByteArray cacheControlFor(const QString &filePath)
{
    if (filePath.endsWith(QLatin1String("index.html"), Qt::CaseInsensitive)
        || filePath.endsWith(QLatin1String("web.html"), Qt::CaseInsensitive)) {
        return QByteArrayLiteral("no-store");
    }
    // Vite emits content-hashed asset names, so a long immutable cache is safe.
    return QByteArrayLiteral("public, max-age=31536000, immutable");
}

} // namespace webassets
