#pragma once

#include <QJsonObject>
#include "../wsl/WslEnvironment.h"

#include <QString>
#include <QStringList>

#include <functional>

/**
 * Prompt-template path authorization.
 *
 * Port of src/main/prompts/promptPathAuthorization.ts + PromptPathAuthorizer.ts.
 *
 * The rules exist because a prompt template is a file the renderer can name directly
 * (`prompts:edit` takes a path), so containment alone is not enough:
 *  - a template must be a *direct* child of the template root (`<root>/<name>.md`),
 *    never a nested path and never a `.d.md` sidecar;
 *  - read/write never follow a symlink leaf; delete uses link mode so the directory
 *    entry is removed instead of its referent;
 *  - a project template root is `<project>/.pi/prompts`, and the `.pi` directory must
 *    not be a dangling link or resolve outside the project root.
 */
namespace promptpaths {

/** Raised for every rejection; the authorizer maps it to the localized copy. */
struct Denied {
    QString reason;
};

/**
 * Authorize one direct `<root>/<name>.md` file. Throws `Denied` on rejection and
 * returns the authorized path (the resolved path for read/write, the lexical path for
 * link mode).
 */
QString assertDirectPromptFile(const QString &filePath, const QString &root, const QString &mode);

/**
 * `<project>/.pi/prompts` for a project whose root is already known to exist.
 * Throws `Denied` when `.pi` escapes the project or when the prompts directory does.
 */
QString assertProjectPromptRoot(const QString &projectRoot);

/**
 * Require `projectPath` to be exactly one of the registered project roots.
 * Throws `Denied` for a sub-directory or an unregistered path.
 */
QString assertRegisteredProjectRoot(const QString &projectPath, const QStringList &roots);

/**
 * A template file name is one directory entry: no separators, no `..`, no NUL.
 * Throws `std::runtime_error` (the oracle throws TypeError) for a non-string value.
 */
QString assertSinglePromptFileName(const QString &fileName);

/** Registered-project lookup used to authorize project templates. */
using ProjectRoots = std::function<QStringList()>;

/**
 * The authorizer the channels use: it owns the localized rejection copy and the
 * global-vs-project dispatch, exactly like `PromptPathAuthorizer`.
 */
class Authorizer {
public:
    using Translate = std::function<QString(const QString &key, const QJsonObject &params)>;

    Authorizer(QString globalRoot, ProjectRoots projectRoots, Translate translate);

    /** Global template file in `mode` ("read" | "write" | "link"). */
    QString global(const QString &filePath, const QString &mode) const;
    /** `<project>/.pi/prompts` for a registered, existing project. */
    QString projectDirectory(const QString &projectPath) const;
    /** Re-point the global root after a environment switch. */
    void setGlobalRoot(const QString &root) { m_globalRoot = root; }
    /** Readable template: global first, then any registered project's template root. */
    QString readable(const QString &filePath) const;

    const QString &globalRoot() const { return m_globalRoot; }

private:
    QString m_globalRoot;
    ProjectRoots m_projectRoots;
    Translate m_translate;
};

} // namespace promptpaths
