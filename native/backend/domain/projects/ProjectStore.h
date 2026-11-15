#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QMutex>
#include <QString>

/**
 * The single owner of the project catalog (`<userData>/projects.json`).
 *
 * Port of src/main/projects/ProjectStore.ts. It is the only place that knows about the
 * built-in chat project, the sort order, worktree child records and the chat directory
 * (`chat-path.json`). Every project-scoped channel resolves through it.
 *
 * Thread safety: the backend dispatches some channels on the thread pool (git worktree
 * registration, for example), so every public method takes the internal mutex. The Node
 * oracle gets the same guarantee for free from its single-threaded event loop.
 */
namespace projects {

class Store {
public:
    /**
     * @param filePath             `<userData>/projects.json`
     * @param chatPathFile         `<userData>/chat-path.json`
     * @param defaultChatPath      `<userData>/chat-workspace`
     */
    Store(QString filePath, QString chatPathFile, QString defaultChatPath);

    /**
     * Load the catalog, synthesise the chat project, repair the sort order and make sure
     * the chat directory exists.
     *
     * `bestEffort` mirrors `loadForStartup()`: only the non-critical initialization
     * steps (chat directory creation, catalog save) may fail without aborting startup,
     * because the user's configured chat path must not silently move.
     */
    void load(bool bestEffort = false);

    QJsonArray list() const;
    /**
     * Sidebar-visible records for the active environment.
     *
     * The chat project is always visible; the rest is filtered by `wslEnabled` so a distro
     * switch never leaves the other environment's projects in the list. Shared by
     * `projects:list` and the startup `projects:changed` frame so the two cannot disagree.
     */
    QJsonArray visibleRecords(const QJsonObject &settings) const;
    /** Sorted record for `id`, or an empty object when unknown. */
    QJsonObject get(const QString &id) const;
    QString chatProjectPath() const;

    /** Persist a new chat directory and return the updated chat project. */
    QJsonObject setChatProjectPath(const QString &path);

    /**
     * Add or refresh a project. `parentId` marks a linked worktree child; an existing
     * top-level record is backfilled with the parent relationship instead of duplicated.
     */
    QJsonObject add(const QString &path, const QString &parentId = QString(),
                    const QString &environment = QString());

    QJsonArray remove(const QString &id);
    QJsonArray reorder(const QStringList &projectIds);

    QJsonArray listRoot() const;
    QJsonArray listWorktreeChildren(const QString &parentId) const;
    QJsonObject findByPath(const QString &path) const;

    /** Flip workspace mode; disabling also drops the child records (never the folders). */
    QJsonObject toggleWorktreeEnabled(const QString &id);

    /** True when the catalog file existed and could not be parsed as a project array. */
    bool corruptOnLoad() const;

private:
    void ensureLoadedLocked() const;
    QJsonArray readProjectsLocked();
    void saveLocked();
    void saveChatProjectPathLocked(const QString &path);
    void loadChatProjectPathLocked();
    void ensureDirectory(const QString &path) const;
    bool ensureChatProjectLocked();
    bool ensureSortOrderLocked();
    double nextSortOrderLocked() const;
    void clearWorktreeChildrenLocked(const QString &parentId);

    QString m_filePath;
    QString m_chatPathFile;
    QString m_chatProjectPath;
    mutable QMutex m_mutex;
    mutable bool m_loaded = false;
    mutable QJsonArray m_projects;
    mutable bool m_repairedOnLoad = false;
    mutable bool m_corruptOnLoad = false;
};

} // namespace projects
