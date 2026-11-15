#include "SessionCatalogStore.h"

#include "CatalogMigration.h"
#include "SessionFiles.h"
#include "SessionIdentity.h"

#include "../ChannelRegistry.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QMutexLocker>
#include <QUuid>

namespace {

constexpr int kCatalogVersion = 1;

QString newUuid()
{
    // Dashed RFC 4122 form, matching the oracle's randomUUID().
    return QUuid::createUuid().toString(QUuid::WithoutBraces);
}

bool isMissingFile(const QString &path)
{
    return !sessionfiles::exists(path);
}

} // namespace

SessionCatalogStore::SessionCatalogStore(QString filePath, Context context, FilePathResolver resolveFilePath,
                                         ProjectPathResolver resolveProjectPath)
    : m_filePath(std::move(filePath)),
      m_context(std::move(context)),
      m_resolveFilePath(std::move(resolveFilePath)),
      m_resolveProjectPath(std::move(resolveProjectPath))
{
}

void SessionCatalogStore::setIdentityContext(const Context &context)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    m_context = context;
}

SessionCatalogStore::Context SessionCatalogStore::identityContext() const
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    return m_context;
}

void SessionCatalogStore::assertLoaded() const
{
    if (!m_loaded) throw ChannelError(QStringLiteral("SessionCatalog.load() must complete before use"));
}

QString SessionCatalogStore::backupFilePath() const
{
    return m_filePath + QStringLiteral(".bak");
}

QVector<CatalogEntry> SessionCatalogStore::readEntries(const QString &path) const
{
    QString raw;
    QString error;
    if (!sessionfiles::readText(path, &raw, &error)) {
        // A missing primary file is normal on first run; the caller distinguishes it
        // from corruption by re-checking existence.
        throw ChannelError(isMissingFile(path) ? QStringLiteral("ENOENT") : error);
    }
    QJsonParseError parseError{};
    const QJsonDocument document = QJsonDocument::fromJson(raw.toUtf8(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        throw ChannelError(QStringLiteral("Invalid Session catalog: %1").arg(path));
    }
    const QJsonObject root = document.object();
    const QJsonValue version = root.value(QStringLiteral("version"));
    // A missing version is legacy v1 compatibility; any other value is refused so a
    // downgrade can never overwrite a newer catalog with older data.
    if (!version.isUndefined() && !version.isNull()) {
        if (!version.isDouble() || int(version.toDouble()) != kCatalogVersion) {
            throw ChannelError(QStringLiteral("Unsupported Session catalog version %1: %2")
                                   .arg(version.toVariant().toString(), path));
        }
    }
    const QJsonValue sessions = root.value(QStringLiteral("sessions"));
    if (!sessions.isArray()) throw ChannelError(QStringLiteral("Invalid Session catalog: %1").arg(path));
    QVector<CatalogEntry> entries;
    const QJsonArray array = sessions.toArray();
    entries.reserve(array.size());
    for (const QJsonValue &value : array) {
        CatalogEntry entry;
        if (!value.isObject() || !catalogjson::fromJson(value.toObject(), &entry)) {
            throw ChannelError(QStringLiteral("Session catalog contains invalid records: %1").arg(path));
        }
        entries.append(entry);
    }
    return entries;
}

void SessionCatalogStore::writeSnapshot(const QVector<CatalogEntry> &entries)
{
    QJsonArray sessions;
    for (const CatalogEntry &entry : entries) sessions.append(catalogjson::toJson(entry));
    const QJsonObject snapshot{
        {QStringLiteral("version"), kCatalogVersion},
        {QStringLiteral("sessions"), sessions},
    };
    const QByteArray content = QJsonDocument(snapshot).toJson(QJsonDocument::Indented);

    QString error;
    if (!sessionfiles::makeDirectory(QFileInfo(m_filePath).absolutePath(), &error)) {
        throw ChannelError(error);
    }
    // Rotate the previous file into `.bak` before the swap. A backup failure must not
    // block the write: `.bak` is redundancy, the primary replace is still atomic.
    if (!m_skipNextBackup && sessionfiles::isFile(m_filePath)) {
        QString backupError;
        if (!sessionfiles::copyAtomic(m_filePath, backupFilePath(), &backupError)) {
            // Best effort only; the primary write below is what the user depends on.
        }
    }
    if (!sessionfiles::writeAtomic(m_filePath, content, &error)) throw ChannelError(error);
    m_skipNextBackup = false;
}

void SessionCatalogStore::load()
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    if (m_loaded) return;
    QString primaryError;
    try {
        m_entries = readEntries(m_filePath);
    } catch (const ChannelError &error) {
        primaryError = error.message();
        if (primaryError.startsWith(QLatin1String("Unsupported Session catalog version"))) {
            // Never fall back to `.bak` here: writing the older snapshot back would
            // silently destroy the newer file the user upgraded to.
            throw;
        }
        try {
            m_entries = readEntries(backupFilePath());
            m_skipNextBackup = true;
        } catch (const ChannelError &backupError) {
            const bool primaryMissing = primaryError == QLatin1String("ENOENT");
            const bool backupMissing = backupError.message() == QLatin1String("ENOENT");
            if (primaryMissing && backupMissing) {
                m_entries.clear();
            } else {
                throw ChannelError(QStringLiteral("Failed to load Session catalog or backup: %1; %2")
                                       .arg(primaryError, backupError.message()));
            }
        }
    }

    // Drafts only represent an unsent composer surface in the current process; after a
    // restart there is no pi session to resume, so they are dropped instead of leaving
    // empty agents in the sidebar forever.
    bool hadDrafts = false;
    QVector<CatalogEntry> kept;
    kept.reserve(m_entries.size());
    for (const CatalogEntry &entry : m_entries) {
        if (entry.status == QLatin1String("draft")) {
            hadDrafts = true;
            continue;
        }
        kept.append(entry);
    }
    if (hadDrafts) {
        m_entries = kept;
        try {
            writeSnapshot(m_entries);
        } catch (const ChannelError &) {
            // Startup cleanup is best effort; memory no longer exposes drafts.
        }
    }

    // Repair legacy relative file paths and merge historical duplicate records that
    // refer to the same file (the sidebar used to show both).
    QStringList originKeys;
    originKeys.reserve(m_entries.size());
    for (const CatalogEntry &entry : m_entries) originKeys.append(originKeyForEntry(entry));
    bool repaired = false;
    const QVector<CatalogEntry> migrated = catalogmigration::migrate(
        m_entries, originKeys, m_resolveFilePath, &repaired);
    if (repaired) {
        m_entries = migrated;
        try {
            writeSnapshot(m_entries);
        } catch (const ChannelError &) {
            // Repair is best effort; memory already reflects the merged records.
        }
    }
    m_loaded = true;
    if (m_skipNextBackup) {
        // The primary file was restored from `.bak`; immediately rewrite it so the
        // next start does not have to recover again.
        writeSnapshot(m_entries);
    }
}

QString SessionCatalogStore::originKeyForEntry(const CatalogEntry &entry) const
{
    if (entry.filePath.isEmpty()) return QString();
    return sessionidentity::buildSessionOriginKey(
        entry.source, entry.environment, entry.filePath,
        entry.wslDistro.isEmpty() ? m_context.wslDistro : entry.wslDistro,
        entry.wslUser.isEmpty() ? m_context.wslUser : entry.wslUser, entry.importedSourceId);
}

QVector<CatalogEntry> SessionCatalogStore::listEntries() const
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    QVector<CatalogEntry> result = m_entries;
    result.append(m_transientEntries);
    return result;
}

bool SessionCatalogStore::get(const QString &id, CatalogEntry *out) const
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    for (const CatalogEntry &entry : m_transientEntries) {
        if (entry.id == id) {
            if (out) *out = entry;
            return true;
        }
    }
    for (const CatalogEntry &entry : m_entries) {
        if (entry.id == id) {
            if (out) *out = entry;
            return true;
        }
    }
    return false;
}

bool SessionCatalogStore::isTransient(const QString &id) const
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    for (const CatalogEntry &entry : m_transientEntries) {
        if (entry.id == id) return true;
    }
    return false;
}

QJsonObject SessionCatalogStore::getRecord(const QString &id, bool *found) const
{
    // The project-path resolver runs while the lock is held so the projection is one
    // coherent snapshot; it only reads `projects.json` and can never call back into the
    // catalog, so this introduces no lock-order cycle.
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    CatalogEntry entry;
    if (!get(id, &entry)) {
        if (found) *found = false;
        return QJsonObject{};
    }
    if (found) *found = true;
    QJsonObject record = recordFromEntry(entry, nullptr);
    if (entry.hasParentSessionPath) {
        // Single-record lookup resolves only the parent identity, not the whole project.
        const QString parentPath =
            sessionidentity::canonicalizeSessionPath(entry.parentSessionPath, entry.environment);
        for (int index = m_entries.size() - 1; index >= 0; --index) {
            const CatalogEntry &candidate = m_entries.at(index);
            if (candidate.projectId != entry.projectId || candidate.filePath.isEmpty()) continue;
            if (sessionidentity::canonicalizeSessionPath(candidate.filePath, candidate.environment)
                == parentPath) {
                record.insert(QStringLiteral("parentSessionId"), candidate.id);
                break;
            }
        }
    }
    return record;
}

QJsonArray SessionCatalogStore::listRecords(const QString &projectId) const
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    QVector<CatalogEntry> entries = m_transientEntries;
    entries.append(m_entries);
    QVector<QJsonObject> records;
    records.reserve(entries.size());
    for (const CatalogEntry &entry : entries) {
        if (!projectId.isEmpty() && entry.projectId != projectId) continue;
        records.append(recordFromEntry(entry, nullptr));
    }
    // Parent ids are resolved per project so two projects with the same relative
    // layout never cross-link.
    catalogmigration::assignParentSessionIds(&records);
    std::sort(records.begin(), records.end(), [](const QJsonObject &left, const QJsonObject &right) {
        return left.value(QStringLiteral("updatedAt")).toDouble()
            > right.value(QStringLiteral("updatedAt")).toDouble();
    });
    QJsonArray result;
    for (const QJsonObject &record : records) result.append(record);
    return result;
}

QJsonArray SessionCatalogStore::listProjectRecords(const QString &projectId) const
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    return listRecords(projectId);
}

bool SessionCatalogStore::findByFilePath(const QString &filePath, const QString &environment,
                                         CatalogEntry *out) const
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    const QString target = sessionidentity::canonicalizeSessionPath(filePath, environment);
    for (const CatalogEntry &entry : m_entries) {
        if (entry.filePath.isEmpty() || entry.environment != environment) continue;
        if (sessionidentity::canonicalizeSessionPath(entry.filePath, environment) == target) {
            if (out) *out = entry;
            return true;
        }
    }
    return false;
}

void SessionCatalogStore::mutate(const Mutation &mutation)
{
    // Copy → durable write → assign is one transaction: releasing the lock between the
    // write and the assign is exactly how a concurrent draft used to be dropped.
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    QVector<CatalogEntry> next = m_entries;
    if (!mutation(next)) return;
    writeSnapshot(next);
    m_entries = next;
}

CatalogEntry SessionCatalogStore::requireEntry(const QVector<CatalogEntry> &entries, const QString &id) const
{
    for (const CatalogEntry &entry : entries) {
        if (entry.id == id) return entry;
    }
    throw ChannelError(QStringLiteral("Session not found: %1").arg(id));
}

QJsonObject SessionCatalogStore::createAnonymous(const QString &projectId, const QString &title,
                                                 const QString &environment, bool hasModel,
                                                 const QString &modelProvider, const QString &modelId,
                                                 bool hasThinkingLevel, const QString &thinkingLevel)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    CatalogEntry entry;
    entry.id = newUuid();
    entry.projectId = projectId;
    entry.title = title;
    entry.noSession = true;
    entry.source = QStringLiteral("pi");
    entry.environment = environment;
    if (environment == QLatin1String("wsl")) {
        entry.wslDistro = m_context.wslDistro;
        entry.wslUser = m_context.wslUser;
    }
    entry.status = QStringLiteral("active");
    entry.hasModel = hasModel;
    entry.modelProvider = modelProvider;
    entry.modelId = modelId;
    entry.hasThinkingLevel = hasThinkingLevel;
    entry.thinkingLevel = thinkingLevel;
    entry.createdAt = now;
    entry.updatedAt = now;
    // Runtime-only: never written to session-catalog.json.
    m_transientEntries.append(entry);
    return recordFromEntry(entry, nullptr);
}

bool SessionCatalogStore::removeTransient(const QString &id)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    for (int index = 0; index < m_transientEntries.size(); ++index) {
        if (m_transientEntries.at(index).id == id) {
            m_transientEntries.removeAt(index);
            return true;
        }
    }
    return false;
}

QJsonObject SessionCatalogStore::createDraft(const QString &projectId, const QString &title,
                                             const QString &environment, const QString &source,
                                             bool hasModel, const QString &modelProvider,
                                             const QString &modelId, bool hasThinkingLevel,
                                             const QString &thinkingLevel)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    CatalogEntry created;
    created.id = newUuid();
    created.projectId = projectId;
    created.title = title;
    created.source = source.isEmpty() ? QStringLiteral("pi") : source;
    created.environment = environment;
    if (environment == QLatin1String("wsl")) {
        created.wslDistro = m_context.wslDistro;
        created.wslUser = m_context.wslUser;
    }
    created.status = QStringLiteral("draft");
    created.hasModel = hasModel;
    created.modelProvider = modelProvider;
    created.modelId = modelId;
    created.hasThinkingLevel = hasThinkingLevel;
    created.thinkingLevel = thinkingLevel;
    created.createdAt = now;
    created.updatedAt = now;
    // A draft is catalog metadata only. Writing a `.jsonl` here would create a file pi
    // cannot load (no `type:"session"` header) and would leave an empty session behind.
    mutate([&created](QVector<CatalogEntry> &entries) {
        entries.append(created);
        return true;
    });
    return recordFromEntry(created, nullptr);
}

QJsonObject SessionCatalogStore::update(const QString &id, const QJsonObject &patch)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    for (CatalogEntry &entry : m_transientEntries) {
        if (entry.id != id) continue;
        if (patch.contains(QStringLiteral("title"))) entry.title = patch.value(QStringLiteral("title")).toString();
        if (patch.contains(QStringLiteral("model"))) {
            const QJsonObject model = patch.value(QStringLiteral("model")).toObject();
            entry.hasModel = true;
            entry.modelProvider = model.value(QStringLiteral("provider")).toString();
            entry.modelId = model.value(QStringLiteral("modelId")).toString();
        }
        if (patch.contains(QStringLiteral("thinkingLevel"))) {
            entry.hasThinkingLevel = true;
            entry.thinkingLevel = patch.value(QStringLiteral("thinkingLevel")).toString();
        }
        entry.updatedAt = patch.contains(QStringLiteral("updatedAt"))
            ? qint64(patch.value(QStringLiteral("updatedAt")).toDouble())
            : QDateTime::currentMSecsSinceEpoch();
        return recordFromEntry(entry, nullptr);
    }
    CatalogEntry updated;
    mutate([&](QVector<CatalogEntry> &entries) {
        for (CatalogEntry &entry : entries) {
            if (entry.id != id) continue;
            if (patch.contains(QStringLiteral("title"))) entry.title = patch.value(QStringLiteral("title")).toString();
            if (patch.contains(QStringLiteral("model"))) {
                const QJsonObject model = patch.value(QStringLiteral("model")).toObject();
                entry.hasModel = true;
                entry.modelProvider = model.value(QStringLiteral("provider")).toString();
                entry.modelId = model.value(QStringLiteral("modelId")).toString();
            }
            if (patch.contains(QStringLiteral("thinkingLevel"))) {
                entry.hasThinkingLevel = true;
                entry.thinkingLevel = patch.value(QStringLiteral("thinkingLevel")).toString();
            }
            entry.updatedAt = patch.contains(QStringLiteral("updatedAt"))
                ? qint64(patch.value(QStringLiteral("updatedAt")).toDouble())
                : QDateTime::currentMSecsSinceEpoch();
            updated = entry;
            return true;
        }
        throw ChannelError(QStringLiteral("Session not found: %1").arg(id));
    });
    return recordFromEntry(updated, nullptr);
}

CatalogEntry SessionCatalogStore::attachRuntime(const QString &sessionId, const QString &filePath,
                                                const QString &piSessionId)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    CatalogEntry updated;
    mutate([&](QVector<CatalogEntry> &entries) {
        CatalogEntry entry = requireEntry(entries, sessionId);
        QString resolved = filePath;
        if (!resolved.isEmpty() && m_resolveFilePath) {
            resolved = m_resolveFilePath(entry.projectId, resolved, entry.environment);
        }
        const QString previousFilePath = entry.filePath;
        if (!resolved.isEmpty()) entry.filePath = resolved;
        if (!piSessionId.isEmpty()) entry.piSessionId = piSessionId;
        if (!entry.filePath.isEmpty()) {
            const bool pathUnchanged = !previousFilePath.isEmpty()
                && sessionidentity::canonicalizeSessionPath(previousFilePath, entry.environment)
                    == sessionidentity::canonicalizeSessionPath(entry.filePath, entry.environment);
            const QString nextOriginKey =
                pathUnchanged && !entry.originKey.isEmpty() ? entry.originKey : originKeyForEntry(entry);
            entry.originKey = nextOriginKey;
            entry.status = QStringLiteral("active");
            if (!nextOriginKey.isEmpty()) {
                int duplicateIndex = -1;
                for (int index = 0; index < entries.size(); ++index) {
                    if (entries.at(index).id != entry.id && entries.at(index).originKey == nextOriginKey) {
                        duplicateIndex = index;
                        break;
                    }
                }
                if (duplicateIndex >= 0) {
                    const CatalogEntry duplicate = entries.at(duplicateIndex);
                    if (!entry.hasModel && duplicate.hasModel) {
                        entry.hasModel = true;
                        entry.modelProvider = duplicate.modelProvider;
                        entry.modelId = duplicate.modelId;
                    }
                    if (!entry.hasThinkingLevel && duplicate.hasThinkingLevel) {
                        entry.hasThinkingLevel = true;
                        entry.thinkingLevel = duplicate.thinkingLevel;
                    }
                    if (entry.importedSourceId.isEmpty()) entry.importedSourceId = duplicate.importedSourceId;
                    entry.createdAt = qMin(entry.createdAt, duplicate.createdAt);
                    entries.removeAt(duplicateIndex);
                }
            }
        }
        entry.updatedAt = QDateTime::currentMSecsSinceEpoch();
        for (int index = 0; index < entries.size(); ++index) {
            if (entries.at(index).id == sessionId) entries[index] = entry;
        }
        updated = entry;
        return true;
    });
    return updated;
}

CatalogEntry SessionCatalogStore::ensureRuntimeTarget(const QString &projectId, const QString &title,
                                                      const QString &source, const QString &environment,
                                                      const QString &filePath, const QString &wslDistro,
                                                      const QString &wslUser, const QString &importedSourceId,
                                                      const QString &piSessionId)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    const QString resolved = m_resolveFilePath
        ? m_resolveFilePath(projectId, filePath, environment)
        : filePath;
    const QString originKey = sessionidentity::buildSessionOriginKey(
        source, environment, resolved, wslDistro, wslUser, importedSourceId);
    CatalogEntry updated;
    mutate([&](QVector<CatalogEntry> &entries) {
        int found = -1;
        for (int index = 0; index < entries.size(); ++index) {
            const CatalogEntry &candidate = entries.at(index);
            if (candidate.originKey == originKey) {
                found = index;
                break;
            }
            if (candidate.filePath.isEmpty()) continue;
            const QString candidateKey = sessionidentity::buildSessionOriginKey(
                candidate.source, candidate.environment, candidate.filePath, candidate.wslDistro,
                candidate.wslUser, candidate.importedSourceId);
            if (candidateKey == originKey) {
                found = index;
                break;
            }
        }
        const qint64 now = QDateTime::currentMSecsSinceEpoch();
        if (found < 0) {
            CatalogEntry entry;
            entry.id = newUuid();
            entry.projectId = projectId;
            entry.originKey = originKey;
            entry.title = title;
            entry.source = source;
            entry.environment = environment;
            entry.filePath = resolved;
            entry.wslDistro = wslDistro;
            entry.wslUser = wslUser;
            entry.importedSourceId = importedSourceId;
            entry.piSessionId = piSessionId;
            entry.status = QStringLiteral("active");
            entry.createdAt = now;
            entry.updatedAt = now;
            entries.append(entry);
            updated = entry;
            return true;
        }
        CatalogEntry &entry = entries[found];
        entry.projectId = projectId;
        entry.originKey = originKey;
        entry.title = title;
        entry.source = source;
        entry.environment = environment;
        entry.filePath = resolved;
        entry.wslDistro = wslDistro;
        entry.wslUser = wslUser;
        entry.importedSourceId = importedSourceId;
        entry.piSessionId = piSessionId;
        entry.status = QStringLiteral("active");
        entry.updatedAt = now;
        updated = entry;
        return true;
    });
    return updated;
}

bool SessionCatalogStore::remove(const QString &id)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    if (removeTransient(id)) return true;
    bool removed = false;
    mutate([&](QVector<CatalogEntry> &entries) {
        for (int index = 0; index < entries.size(); ++index) {
            if (entries.at(index).id != id) continue;
            entries.removeAt(index);
            removed = true;
            return true;
        }
        return false;
    });
    return removed;
}

bool SessionCatalogStore::removeByFilePath(const QString &filePath, const QString &environment)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    assertLoaded();
    const QString target = sessionidentity::canonicalizeSessionPath(filePath, environment);
    bool removed = false;
    mutate([&](QVector<CatalogEntry> &entries) {
        for (int index = 0; index < entries.size(); ++index) {
            const CatalogEntry &entry = entries.at(index);
            if (entry.filePath.isEmpty() || entry.environment != environment) continue;
            if (sessionidentity::canonicalizeSessionPath(entry.filePath, environment) != target) continue;
            entries.removeAt(index);
            removed = true;
            return true;
        }
        return false;
    });
    return removed;
}
