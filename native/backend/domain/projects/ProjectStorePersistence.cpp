#include "ProjectStore.h"

#include "JsonFile.h"
#include "ProjectRecord.h"

#include "../../process/TextEncoding.h"

#include <algorithm>
#include <limits>

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QJsonValue>
#include <QMutexLocker>

namespace projects {
namespace {

double nowMs()
{
    return double(QDateTime::currentMSecsSinceEpoch());
}

} // namespace

void Store::load(bool bestEffort)
{
    QMutexLocker locker(&m_mutex);
    m_projects = readProjectsLocked();
    loadChatProjectPathLocked();
    const bool chatChanged = ensureChatProjectLocked();
    const bool orderChanged = ensureSortOrderLocked();
    const bool changed = chatChanged || orderChanged || m_repairedOnLoad;
    m_repairedOnLoad = false;
    m_loaded = true;

    // Only the non-critical startup steps may fail without aborting the load: the
    // records themselves are already in memory and a later load can retry.
    const auto step = [bestEffort](const std::function<void()> &task) {
        try {
            task();
        } catch (const std::exception &error) {
            if (!bestEffort) throw;
            qWarning("projects: startup initialization failed: %s", error.what());
        }
    };
    step([this]() { ensureDirectory(m_chatProjectPath); });
    if (changed) step([this]() { saveLocked(); });
}

void Store::ensureLoadedLocked() const
{
    if (m_loaded) return;
    // Every channel may be the first caller; loading lazily keeps the constructor cheap
    // and makes the store usable from tests without an explicit boot sequence.
    const_cast<Store *>(this)->load(false);
}

QJsonArray Store::readProjectsLocked()
{
    QFileInfo info(m_filePath);
    if (!info.exists()) return {};
    jsonfile::ReadState state = jsonfile::ReadState::Ok;
    QJsonValue value;
    QString error;
    state = jsonfile::readJson(m_filePath, &value, &error);
    if (state == jsonfile::ReadState::Missing) return {};
    if (state == jsonfile::ReadState::Unreadable) {
        m_corruptOnLoad = true;
        throw textenc::error(
            QStringLiteral("Unable to read project catalog: %1").arg(m_filePath));
    }
    CatalogParse parsed;
    if (state == jsonfile::ReadState::Invalid || !parseProjectCatalog(value, &parsed)) {
        // The whole file is unusable: keep a forensic copy, then rebuild on the next save.
        m_corruptOnLoad = true;
        QString preserveError;
        if (jsonfile::preserveCorrupt(m_filePath, &preserveError).isEmpty()) {
            throw textenc::error(
                QStringLiteral("Unable to preserve corrupt project catalog: %1")
                    .arg(preserveError)
                    );
        }
        return {};
    }
    if (parsed.dropped > 0) {
        // Some records were invalid: keep the original for inspection, load the rest and
        // let load() write the cleaned list back.
        m_corruptOnLoad = true;
        QString preserveError;
        if (jsonfile::preserveCorrupt(m_filePath, &preserveError).isEmpty()) {
            throw textenc::error(
                QStringLiteral("Unable to preserve corrupt project catalog: %1")
                    .arg(preserveError)
                    );
        }
        m_repairedOnLoad = true;
    }
    return parsed.projects;
}

void Store::saveLocked()
{
    QString error;
    if (!jsonfile::writeJsonAtomic(m_filePath, m_projects, &error)) {
        throw textenc::error(QStringLiteral("Unable to save project catalog: %1")
                                     .arg(error)
                                     );
    }
}

void Store::saveChatProjectPathLocked(const QString &path)
{
    QString error;
    const QJsonObject payload{{QStringLiteral("path"), path}};
    if (!jsonfile::writeJsonAtomic(m_chatPathFile, payload, &error)) {
        throw textenc::error(QStringLiteral("Unable to save chat path: %1")
                                     .arg(error)
                                     );
    }
}

void Store::loadChatProjectPathLocked()
{
    QJsonValue value;
    if (jsonfile::readJson(m_chatPathFile, &value, nullptr) != jsonfile::ReadState::Ok) return;
    const QString path = value.toObject().value(QStringLiteral("path")).toString();
    if (!path.isEmpty()) m_chatProjectPath = normalizeProjectPath(path);
}

void Store::ensureDirectory(const QString &path) const
{
    const QFileInfo info(path);
    if (info.exists()) {
        if (!info.isDir()) {
            throw textenc::error(
                QStringLiteral("Path is not a directory: %1").arg(path));
        }
        return;
    }
    if (!QDir().mkpath(path)) {
        throw textenc::error(
            QStringLiteral("Unable to create directory: %1").arg(path));
    }
}

bool Store::ensureChatProjectLocked()
{
    int existingIndex = -1;
    for (int index = 0; index < m_projects.size(); ++index) {
        if (isChatProject(m_projects.at(index).toObject())) {
            existingIndex = index;
            break;
        }
    }
    const QJsonObject existing =
        existingIndex >= 0 ? m_projects.at(existingIndex).toObject() : QJsonObject{};
    QJsonObject next{
        {QStringLiteral("id"), kChatProjectId},
        {QStringLiteral("name"), kChatProjectName},
        {QStringLiteral("path"), m_chatProjectPath},
        {QStringLiteral("lastOpenedAt"),
         existing.contains(QStringLiteral("lastOpenedAt"))
             ? existing.value(QStringLiteral("lastOpenedAt"))
             : QJsonValue(nowMs())},
        {QStringLiteral("pinned"), true},
        {QStringLiteral("sortOrder"), -1},
        {QStringLiteral("kind"), QStringLiteral("chat")},
    };
    if (existingIndex < 0) {
        m_projects.prepend(next);
        return true;
    }
    bool changed = false;
    for (auto it = next.begin(); it != next.end(); ++it) {
        if (existing.value(it.key()) != it.value()) {
            changed = true;
            break;
        }
    }
    // Object.assign semantics: the built-in identity always wins, user fields that are
    // not part of the chat record (a stale worktreeParentId, for example) are dropped.
    QJsonObject merged = next;
    m_projects.replace(existingIndex, merged);
    const int previousSize = m_projects.size();
    QJsonArray filtered;
    for (int index = 0; index < m_projects.size(); ++index) {
        const QJsonObject project = m_projects.at(index).toObject();
        // Only duplicate chat records are collapsed; a normal project that happens to
        // share the chat directory stays.
        if (index == existingIndex) {
            filtered.append(project);
            continue;
        }
        if (!isChatProject(project) && project.value(QStringLiteral("id")).toString() != kChatProjectId) {
            filtered.append(project);
        }
    }
    m_projects = filtered;
    return changed || m_projects.size() != previousSize;
}

bool Store::ensureSortOrderLocked()
{
    bool needsOrder = false;
    for (const QJsonValue &value : m_projects) {
        const QJsonValue order = value.toObject().value(QStringLiteral("sortOrder"));
        if (!order.isDouble() || !std::isfinite(order.toDouble())) {
            needsOrder = true;
            break;
        }
    }
    if (!needsOrder) return false;

    // First upgrade of legacy data keeps the previous "pinned first, most recent" order;
    // after that the user's drag order owns the field.
    QList<QJsonObject> ordered;
    for (const QJsonValue &value : m_projects) {
        const QJsonObject project = value.toObject();
        if (!isChatProject(project)) ordered.append(project);
    }
    std::stable_sort(ordered.begin(), ordered.end(),
                     [](const QJsonObject &left, const QJsonObject &right) {
                         const int pinnedRank = int(right.value(QStringLiteral("pinned")).toBool())
                             - int(left.value(QStringLiteral("pinned")).toBool());
                         if (pinnedRank != 0) return pinnedRank < 0;
                         return left.value(QStringLiteral("lastOpenedAt")).toDouble()
                             > right.value(QStringLiteral("lastOpenedAt")).toDouble();
                     });
    for (int index = 0; index < ordered.size(); ++index) {
        QJsonObject project = ordered.at(index);
        project.insert(QStringLiteral("sortOrder"), index);
        for (int slot = 0; slot < m_projects.size(); ++slot) {
            if (m_projects.at(slot).toObject().value(QStringLiteral("id")).toString()
                == project.value(QStringLiteral("id")).toString()) {
                m_projects.replace(slot, project);
                break;
            }
        }
    }
    for (int index = 0; index < m_projects.size(); ++index) {
        QJsonObject project = m_projects.at(index).toObject();
        if (!isChatProject(project)) continue;
        project.insert(QStringLiteral("sortOrder"), -1);
        m_projects.replace(index, project);
    }
    return true;
}

double Store::nextSortOrderLocked() const
{
    if (m_projects.isEmpty()) return 0;
    double maximum = -std::numeric_limits<double>::infinity();
    for (const QJsonValue &value : m_projects) {
        maximum = std::max(maximum, projectSortOrder(value.toObject()));
    }
    if (!std::isfinite(maximum) || maximum >= double(std::numeric_limits<qint64>::max())) {
        return double(m_projects.size());
    }
    return maximum + 1;
}


} // namespace projects
