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
#include <QUuid>

namespace projects {
namespace {

double nowMs()
{
    return double(QDateTime::currentMSecsSinceEpoch());
}

QString baseName(const QString &path)
{
    const QString name = QFileInfo(path).fileName();
    return name.isEmpty() ? path : name;
}

} // namespace

Store::Store(QString filePath, QString chatPathFile, QString defaultChatPath)
    : m_filePath(std::move(filePath))
    , m_chatPathFile(std::move(chatPathFile))
    , m_chatProjectPath(normalizeProjectPath(defaultChatPath))
{
}

QJsonArray Store::list() const
{
    QMutexLocker locker(&m_mutex);
    ensureLoadedLocked();
    return sortProjects(m_projects);
}

QJsonArray Store::visibleRecords(const QJsonObject &settings) const
{
    const bool wslEnabled = settings.value(QStringLiteral("wslEnabled")).toBool();
    QJsonArray visible;
    for (const QJsonValue &value : list()) {
        const QJsonObject project = value.toObject();
        if (project.value(QStringLiteral("kind")).toString() == QStringLiteral("chat")) {
            visible.append(project);
            continue;
        }
        const QString environment = project.value(QStringLiteral("environment")).toString();
        if (wslEnabled) {
            if (environment == QStringLiteral("wsl")) visible.append(project);
            continue;
        }
        // An empty environment is a pre-WSL record on Windows; it must keep showing.
        if (environment.isEmpty() || environment == QStringLiteral("windows")) visible.append(project);
    }
    return visible;
}

QJsonObject Store::get(const QString &id) const
{
    QMutexLocker locker(&m_mutex);
    ensureLoadedLocked();
    for (const QJsonValue &value : m_projects) {
        const QJsonObject project = value.toObject();
        if (project.value(QStringLiteral("id")).toString() == id) return project;
    }
    return {};
}

QString Store::chatProjectPath() const
{
    QMutexLocker locker(&m_mutex);
    ensureLoadedLocked();
    return m_chatProjectPath;
}

QJsonObject Store::setChatProjectPath(const QString &path)
{
    QMutexLocker locker(&m_mutex);
    ensureLoadedLocked();
    const QString normalized = normalizeProjectPath(path);
    // A chat directory that is also a registered project makes the two records fight
    // over one folder (issue #149), so it is rejected instead of silently merged.
    for (const QJsonValue &value : m_projects) {
        const QJsonObject project = value.toObject();
        if (isChatProject(project)) continue;
        if (sameProjectPath(project.value(QStringLiteral("path")).toString(), normalized)) {
            throw std::runtime_error("CHAT_PATH_OVERLAPS_PROJECT");
        }
    }
    ensureDirectory(normalized);

    m_chatProjectPath = normalized;
    QJsonObject chat;
    for (int index = 0; index < m_projects.size(); ++index) {
        QJsonObject project = m_projects.at(index).toObject();
        if (!isChatProject(project)) continue;
        project.insert(QStringLiteral("path"), normalized);
        m_projects.replace(index, project);
        chat = project;
        break;
    }
    saveChatProjectPathLocked(normalized);
    saveLocked();
    return chat;
}

QJsonObject Store::add(const QString &path, const QString &parentId, const QString &environment)
{
    QMutexLocker locker(&m_mutex);
    ensureLoadedLocked();
    const QString normalized = normalizeProjectPath(path);
    if (normalized.isEmpty()) throw std::runtime_error("Project path is required");

    for (int index = 0; index < m_projects.size(); ++index) {
        QJsonObject project = m_projects.at(index).toObject();
        // The chat project never matches "already added": a folder the user picks must
        // become a real project even when it equals the chat directory.
        if (isChatProject(project)) continue;
        if (!sameProjectPath(project.value(QStringLiteral("path")).toString(), normalized)) continue;
        project.insert(QStringLiteral("path"), normalized);
        project.insert(QStringLiteral("lastOpenedAt"), nowMs());
        if (!parentId.isEmpty()
            && project.value(QStringLiteral("id")).toString() != parentId) {
            project.insert(QStringLiteral("worktreeParentId"), parentId);
            project.insert(QStringLiteral("pinned"), false);
        }
        m_projects.replace(index, project);
        saveLocked();
        return project;
    }

    QJsonObject created{
        {QStringLiteral("id"), QUuid::createUuid().toString(QUuid::WithoutBraces)},
        {QStringLiteral("name"), baseName(normalized)},
        {QStringLiteral("path"), normalized},
        {QStringLiteral("lastOpenedAt"), nowMs()},
        {QStringLiteral("sortOrder"), nextSortOrderLocked()},
        {QStringLiteral("environment"),
         environment == QStringLiteral("wsl") ? QStringLiteral("wsl") : QStringLiteral("windows")},
    };
    if (!parentId.isEmpty()) created.insert(QStringLiteral("worktreeParentId"), parentId);
    m_projects.append(created);
    saveLocked();
    return created;
}

QJsonArray Store::remove(const QString &id)
{
    QMutexLocker locker(&m_mutex);
    ensureLoadedLocked();
    QJsonArray kept;
    for (const QJsonValue &value : m_projects) {
        const QJsonObject project = value.toObject();
        // Removing a parent also removes its worktree children, otherwise they survive as
        // invisible orphans.
        if (project.value(QStringLiteral("id")).toString() == id) continue;
        if (project.value(QStringLiteral("worktreeParentId")).toString() == id) continue;
        kept.append(project);
    }
    m_projects = kept;
    ensureChatProjectLocked();
    ensureSortOrderLocked();
    saveLocked();
    return sortProjects(m_projects);
}

QJsonArray Store::reorder(const QStringList &projectIds)
{
    QMutexLocker locker(&m_mutex);
    ensureLoadedLocked();
    for (int index = 0; index < m_projects.size(); ++index) {
        QJsonObject project = m_projects.at(index).toObject();
        if (!isChatProject(project)) continue;
        project.insert(QStringLiteral("sortOrder"), -1);
        m_projects.replace(index, project);
    }
    int order = 0;
    for (const QString &id : projectIds) {
        for (int index = 0; index < m_projects.size(); ++index) {
            QJsonObject project = m_projects.at(index).toObject();
            if (isChatProject(project)) continue;
            if (project.value(QStringLiteral("id")).toString() != id) continue;
            project.insert(QStringLiteral("sortOrder"), order++);
            m_projects.replace(index, project);
        }
    }
    // Projects missing from the list (a worktree discovered in the background) go last.
    for (int index = 0; index < m_projects.size(); ++index) {
        QJsonObject project = m_projects.at(index).toObject();
        if (isChatProject(project)) continue;
        if (projectIds.contains(project.value(QStringLiteral("id")).toString())) continue;
        project.insert(QStringLiteral("sortOrder"), order++);
        m_projects.replace(index, project);
    }
    saveLocked();
    return sortProjects(m_projects);
}

QJsonArray Store::listRoot() const
{
    QJsonArray roots;
    for (const QJsonValue &value : list()) {
        const QJsonObject project = value.toObject();
        if (project.value(QStringLiteral("worktreeParentId")).toString().isEmpty()) {
            roots.append(project);
        }
    }
    return roots;
}

QJsonArray Store::listWorktreeChildren(const QString &parentId) const
{
    QJsonArray children;
    for (const QJsonValue &value : list()) {
        const QJsonObject project = value.toObject();
        if (project.value(QStringLiteral("worktreeParentId")).toString() == parentId) {
            children.append(project);
        }
    }
    return children;
}

QJsonObject Store::findByPath(const QString &path) const
{
    QMutexLocker locker(&m_mutex);
    ensureLoadedLocked();
    const QString normalized = normalizeProjectPath(path);
    for (const QJsonValue &value : m_projects) {
        const QJsonObject project = value.toObject();
        if (sameProjectPath(project.value(QStringLiteral("path")).toString(), normalized)) {
            return project;
        }
    }
    return {};
}

void Store::clearWorktreeChildrenLocked(const QString &parentId)
{
    QJsonArray kept;
    for (const QJsonValue &value : m_projects) {
        const QJsonObject project = value.toObject();
        if (project.value(QStringLiteral("worktreeParentId")).toString() == parentId
            && !isChatProject(project)) {
            continue;
        }
        kept.append(project);
    }
    m_projects = kept;
}

QJsonObject Store::toggleWorktreeEnabled(const QString &id)
{
    QMutexLocker locker(&m_mutex);
    ensureLoadedLocked();
    for (int index = 0; index < m_projects.size(); ++index) {
        QJsonObject project = m_projects.at(index).toObject();
        if (project.value(QStringLiteral("id")).toString() != id) continue;
        const bool enabled = !project.value(QStringLiteral("worktreeEnabled")).toBool();
        project.insert(QStringLiteral("worktreeEnabled"), enabled);
        m_projects.replace(index, project);
        // Disabling workspace mode drops the child records only; the physical worktree
        // folders are never deleted here.
        if (!enabled) clearWorktreeChildrenLocked(id);
        saveLocked();
        return project;
    }
    return {};
}

bool Store::corruptOnLoad() const
{
    QMutexLocker locker(&m_mutex);
    return m_corruptOnLoad;
}

} // namespace projects
