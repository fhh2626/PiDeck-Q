#include "StaticFiles.h"

#include <QDir>
#include <QFileInfo>

namespace {

QString normalizedForCompare(QString path)
{
    path = QDir::cleanPath(QDir::fromNativeSeparators(path));
#ifdef Q_OS_WIN
    path = path.toLower();
#endif
    return path;
}

bool hasExtension(const QString &path)
{
    const QString name = QFileInfo(path).fileName();
    const int dot = name.lastIndexOf(QLatin1Char('.'));
    // A leading dot (".well-known") is not an extension.
    return dot > 0;
}

} // namespace

namespace staticfiles {

bool isInsideRoot(const QString &root, const QString &candidate)
{
    const QString normalizedRoot = normalizedForCompare(root);
    const QString normalizedCandidate = normalizedForCompare(candidate);
    if (normalizedRoot.isEmpty()) return false;
    if (normalizedCandidate == normalizedRoot) return true;
    return normalizedCandidate.startsWith(normalizedRoot + QLatin1Char('/'));
}

Resolution resolve(const QString &root, const QByteArray &decodedPath, qint64 maxBytes)
{
    Resolution result;
    const QString canonicalRoot = QFileInfo(root).canonicalFilePath();
    if (canonicalRoot.isEmpty()) {
        result.kind = Kind::NotFound;
        return result;
    }

    QString requested = QString::fromUtf8(decodedPath);
    if (requested.isEmpty()) requested = QStringLiteral("/");
    if (requested == QLatin1String("/") || !hasExtension(requested)) requested = QStringLiteral("/index.html");

    const auto tryFile = [&](const QString &relative, Resolution *out) -> bool {
        const QString candidate = QDir(canonicalRoot).filePath(QStringLiteral(".") + relative);
        const QString canonicalCandidate = QFileInfo(candidate).canonicalFilePath();
        if (canonicalCandidate.isEmpty()) return false;
        if (!isInsideRoot(canonicalRoot, canonicalCandidate)) {
            out->kind = Kind::Forbidden;
            return true;
        }
        const QFileInfo info(canonicalCandidate);
        if (!info.isFile()) return false;
        if (info.size() > maxBytes) {
            out->kind = Kind::TooLarge;
            return true;
        }
        out->kind = Kind::File;
        out->path = canonicalCandidate;
        out->size = info.size();
        return true;
    };

    if (tryFile(requested, &result)) return result;
    if (result.kind == Kind::Forbidden || result.kind == Kind::TooLarge) return result;

    // SPA fallback: a client-side route is not a file, so serve the shell. A missing
    // real asset (has an extension) must stay a 404 instead of returning HTML.
    if (requested != QLatin1String("/index.html") && !hasExtension(requested)) {
        if (tryFile(QStringLiteral("/index.html"), &result)) return result;
    }
    result.kind = Kind::NotFound;
    return result;
}

} // namespace staticfiles
