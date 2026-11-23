
#include "ScanRoots.h"
#include "SummaryCache.h"
#include "SessionFiles.h"
#include "SessionIdentity.h"
#include "SessionScanner.h"
#include "SummaryReader.h"

#include "../ChannelRegistry.h"

#include <QDateTime>
#include <QDir>
#include <QJsonDocument>
#include <QJsonObject>

#include <algorithm>

namespace {

constexpr int kArchiveNameAttempts = 20;

/** Parse `{archivedPath: originalPath}`; a non-string value means "corrupt". */
bool parseArchiveIndex(const QString &raw, QJsonObject *out)
{
    const QJsonDocument document = QJsonDocument::fromJson(raw.toUtf8());
    if (!document.isObject()) return false;
    const QJsonObject object = document.object();
    for (auto iterator = object.constBegin(); iterator != object.constEnd(); ++iterator) {
        if (!iterator.value().isString()) return false;
    }
    *out = object;
    return true;
}

} // namespace

QString SessionScanner::archiveIndexPath() const
{
    const QString root = m_config.sessionsDir.isEmpty()
        ? scanroots::defaultSessionsRoot(fs(), m_config.hostHome)
        : m_config.sessionsDir;
    return fs().join(fs().join(root, QLatin1String(sessionfiles::kArchiveDirName)),
                            QLatin1String(sessionfiles::kArchiveIndexName));
}

QJsonObject SessionScanner::readArchiveIndex() const
{
    const QString indexPath = archiveIndexPath();
    QString raw;
    QString error;
    if (!fs().readText(indexPath, &raw, &error)) {
        if (!fs().exists(indexPath)) return QJsonObject{};
        throw ChannelError(error);
    }
    QJsonObject parsed;
    if (parseArchiveIndex(raw, &parsed)) return parsed;
    // A corrupt index must never be silently replaced by `{}`: that would drop every
    // historical mapping. Preserve the original next to it and start a fresh one.
    const QString backup = indexPath + QStringLiteral(".corrupt-")
        + QString::number(QDateTime::currentMSecsSinceEpoch());
    QString moveError;
    if (!fs().moveNoClobber(indexPath, backup, &moveError)) throw ChannelError(moveError);
    return QJsonObject{};
}

void SessionScanner::writeArchiveIndex(const QJsonObject &entries) const
{
    const QString indexPath = archiveIndexPath();
    QString error;
    if (!fs().makeDirectory(fs().dirname(indexPath))) {
        throw ChannelError(QStringLiteral("Unable to create the archive directory"));
    }
    const QByteArray content = QJsonDocument(entries).toJson(QJsonDocument::Indented);
    if (!fs().writeAtomic(indexPath, QString::fromUtf8(content), &error)) throw ChannelError(error);
}

QString SessionScanner::archive(const QString &filePath)
{
    const QString root = findRootForFile(filePath);
    if (root.isEmpty()) throw ChannelError(QStringLiteral("Session is outside every scan root"));
    const QString archiveDir = fs().join(root, QLatin1String(sessionfiles::kArchiveDirName));
    if (!fs().makeDirectory(archiveDir)) {
        throw ChannelError(QStringLiteral("Unable to create the archive directory"));
    }
    const QString stem = fs().stem(filePath);

    // The parent file and its companion directory must share one archive stem: restore
    // derives `<stem>/` from `<stem>.jsonl`, so both names must be free.
    QString archiveStem;
    bool found = false;
    for (int attempt = 0; attempt <= kArchiveNameAttempts; ++attempt) {
        archiveStem = attempt == 0
            ? stem
            : QStringLiteral("%1.%2-%3").arg(stem).arg(QDateTime::currentMSecsSinceEpoch()).arg(attempt);
        const QString fileTarget = fs().join(archiveDir, archiveStem + QStringLiteral(".jsonl"));
        const QString dirTarget = fs().join(archiveDir, archiveStem);
        if (!fs().exists(fileTarget) && !fs().exists(dirTarget)) {
            found = true;
            break;
        }
    }
    if (!found) throw ChannelError(QStringLiteral("ARCHIVE_NAME_EXHAUSTED"));

    const QString finalTarget = fs().join(archiveDir, archiveStem + QStringLiteral(".jsonl"));
    const QString siblingDir = siblingDirectory(filePath);
    const QString siblingTarget = fs().join(archiveDir, archiveStem);
    const bool hasSibling = !siblingDir.isEmpty() && fs().exists(siblingDir);

    // Order: companion dir → file → index. Any failure rolls the completed steps back
    // so the disk state matches the pre-call state (never "failed but moved").
    QString error;
    if (hasSibling && !fs().moveNoClobber(siblingDir, siblingTarget, &error)) throw ChannelError(error);
    if (!fs().moveNoClobber(filePath, finalTarget, &error)) {
        if (hasSibling) {
            QString ignored;
            fs().moveNoClobber(siblingTarget, siblingDir, &ignored);
        }
        throw ChannelError(error);
    }
    try {
        QJsonObject entries = readArchiveIndex();
        entries.insert(finalTarget, filePath);
        writeArchiveIndex(entries);
    } catch (const std::exception &) {
        QString ignored;
        fs().moveNoClobber(finalTarget, filePath, &ignored);
        if (hasSibling) fs().moveNoClobber(siblingTarget, siblingDir, &ignored);
        throw;
    }
    return finalTarget;
}

QString SessionScanner::unarchive(const QString &archivedPath)
{
    const QJsonObject entries = readArchiveIndex();
    QJsonValue originalValue = entries.value(archivedPath);
    QString matchedKey = archivedPath;
    if (!originalValue.isString()) {
        // The renderer normally echoes the path we returned, but a hand-edited index or a
        // differently separated path must still restore instead of failing the lookup.
        const QString normalized = sessionidentity::normalizeScanPath(archivedPath);
        for (auto iterator = entries.constBegin(); iterator != entries.constEnd(); ++iterator) {
            if (sessionidentity::normalizeScanPath(iterator.key()) != normalized) continue;
            originalValue = iterator.value();
            matchedKey = iterator.key();
            break;
        }
    }
    if (!originalValue.isString()) throw ChannelError(QStringLiteral("Archive index has no entry for this session"));
    const QString originalPath = originalValue.toString();

    const QString archivedSibling = [&] {
        if (!archivedPath.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive)) return QString();
        return archivedPath.left(archivedPath.size() - 6);
    }();
    const QString originalSibling = [&] {
        if (!originalPath.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive)) return QString();
        return originalPath.left(originalPath.size() - 6);
    }();
    const bool hasSibling = !archivedSibling.isEmpty() && fs().exists(archivedSibling);

    // Check every target before touching anything: an occupied path rejects the whole
    // restore instead of leaving the session half-returned.
    if (fs().exists(originalPath)) throw ChannelError(QStringLiteral("Original path is already occupied"));
    if (hasSibling && fs().exists(originalSibling)) {
        throw ChannelError(QStringLiteral("Original path is already occupied"));
    }

    QString error;
    if (hasSibling && !fs().moveNoClobber(archivedSibling, originalSibling, &error)) {
        throw ChannelError(error);
    }
    if (!fs().moveNoClobber(archivedPath, originalPath, &error)) {
        if (hasSibling) {
            QString ignored;
            fs().moveNoClobber(originalSibling, archivedSibling, &ignored);
        }
        throw ChannelError(error);
    }
    QJsonObject next = readArchiveIndex();
    next.remove(matchedKey);
    writeArchiveIndex(next);
    return originalPath;
}

QVector<SessionSummary> SessionScanner::listArchived()
{
    // Archived sessions may live under any scan root (default global + project sessionDir),
    // so every root is visited with the last resolved root set.
    const SessionFs scanFs = fs();
    const QStringList resolvedRoots = activeScanRoots();
    const QStringList roots = resolvedRoots.isEmpty()
        ? QStringList{scanroots::defaultSessionsRoot(scanFs, m_config.hostHome)}
        : resolvedRoots;

    summaryreader::Context context;
    context.fs = scanFs;
    context.scanRoots = roots;
    context.translate = m_translate;
    context.hostHome = m_config.hostHome;
    context.codexRoot = QDir(m_config.hostHome).filePath(QStringLiteral(".codex/sessions"));

    m_summaryCache->ensureLoaded();
    QVector<SessionSummary> summaries;
    QSet<QString> seen;
    for (const QString &root : roots) {
        const QString archiveDir = scanFs.join(root, QLatin1String(sessionfiles::kArchiveDirName));
        for (const QString &file : scanFs.collectJsonl(archiveDir, true)) {
            const QString key = sessionidentity::normalizeScanPath(file);
            if (seen.contains(key)) continue;
            seen.insert(key);
            qint64 mtimeMs = 0;
            qint64 size = 0;
            if (!scanFs.statVersion(file, &mtimeMs, &size)) continue;
            // Archived files are not part of the regular scan, so the first listing after
            // archiving is a cache miss; a short-lived restore dialog then reuses it.
            const summarycache::Cache::Value cached = m_summaryCache->get(file, mtimeMs, size);
            if (cached.lookup == summarycache::Cache::Lookup::Negative) continue;
            if (cached.lookup == summarycache::Cache::Lookup::Hit) {
                summaries.append(cached.summary);
                continue;
            }
            QString raw;
            QString error;
            if (!scanFs.readText(file, &raw, &error)) continue;
            const summaryreader::Result result = summaryreader::read(file, raw, mtimeMs, context);
            if (!result.isSession) {
                m_summaryCache->set(file, mtimeMs, size, nullptr);
                continue;
            }
            m_summaryCache->set(file, mtimeMs, size, &result.summary);
            summaries.append(result.summary);
        }
    }
    std::sort(summaries.begin(), summaries.end(), [](const SessionSummary &left, const SessionSummary &right) {
        return left.updatedAt > right.updatedAt;
    });
    return summaries;
}
