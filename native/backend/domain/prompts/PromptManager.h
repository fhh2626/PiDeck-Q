#pragma once

#include "PromptPaths.h"
#include "PromptTypes.h"

#include "MainCopy.h"

#include "../wsl/WslEnvironment.h"

#include <QHash>
#include <QString>
#include <QStringList>

#include <functional>

/**
 * Global and project prompt templates (`prompts:*`).
 *
 * Port of src/main/prompts/PromptManager.ts. A template is a markdown file with a
 * `description:` frontmatter field that pi expands from `/<name>`; PiDeck only manages
 * the files and the built-in catalogue, pi owns the expansion.
 *
 * Invariants:
 *  - the global root and every project root are authorized before any IO, so a
 *    renderer-supplied path can never reach an arbitrary file;
 *  - a built-in template has no file: deleting one records the name in
 *    `settings.hiddenBuiltinPromptNames` and `prompts:restore-builtins` clears it;
 *  - creation uses an exclusive write, so two concurrent imports cannot overwrite
 *    each other (the oracle relies on `flag: "wx"` for the same reason).
 *
 * The manager is synchronous; deletions return the authorized path so the channel can
 * hand it to the host recycle bin instead of unlinking user content.
 */
namespace prompts {

/** Persisted hidden built-in names (`settings.hiddenBuiltinPromptNames`). */
struct HiddenStore {
    std::function<QStringList()> read;
    std::function<void(const QStringList &)> write;
};

/** A deletion the channel must perform through `shell.trashItem`. */
struct DeleteTarget {
    /** The built-in was hidden in settings; nothing to trash. */
    bool handledInSettings = false;
    QString path;
    /** Audit source recorded by the host request (`prompts:delete*`). */
    QString source;
};

class Manager {
public:
    Manager(QString promptsDir, promptpaths::ProjectRoots projectRoots, HiddenStore hidden,
            maincopy::Translator translate);

    const QString &dir() const { return m_promptsDir; }

    /**
     * Point the global template directory at the resolved WSL home; `nullptr` restores
     * the directory injected at construction (an isolated test home stays intact).
     * Project directories are unaffected: they are resolved per project.
     */
    void configureWsl(const wsl::Environment *environment);

    /** Create the global directory if needed and return its path. */
    QString ensureDir() const;

    /** Global templates plus the built-ins the user has not created or hidden. */
    prompttpl::ListResult list() const;

    prompttpl::Template create(const QString &name, const QString &description) const;

    /** Hide a built-in, or return the authorized file for the recycle bin. */
    DeleteTarget prepareDelete(const QString &filePath) const;

    bool hasHiddenBuiltins() const;
    /** Validated hidden names: known built-ins only, trimmed, de-duplicated, in order. */
    QStringList hiddenBuiltinNames() const;
    void restoreHiddenBuiltins() const;

    prompttpl::ListResult listByProject(const QString &projectPath) const;
    prompttpl::Template createInProject(const QString &projectPath, const QString &name,
                                        const QString &description) const;
    DeleteTarget prepareDeleteInProject(const QString &projectPath, const QString &fileName) const;
    prompttpl::Template renameInProject(const QString &projectPath, const QString &oldName,
                                        const QString &newName) const;

    QString readContent(const QString &filePath) const;
    void writeContent(const QString &filePath, const QString &content) const;
    prompttpl::Template rename(const QString &oldName, const QString &newName) const;

    /** `normalizeName`: keep Unicode letters/digits/hyphens, collapse, lowercase. */
    static QString normalizeName(const QString &value);

    /** Frontmatter map of a template body (`description`, `argument-hint`, ...). */
    static QHash<QString, QString> parseFrontmatter(const QString &raw);

private:
    QString requireProjectPromptsDir(const QString &projectPath) const;
    void hideBuiltin(const QString &name) const;
    void writeHidden(const QStringList &names) const;

    QString m_promptsDir;
    /** Construction-time global directory; `configureWsl(nullptr)` restores it. */
    QString m_localPromptsDir;
    promptpaths::Authorizer m_authorizer;
    HiddenStore m_hidden;
    maincopy::Translator m_translate;
};

} // namespace prompts
