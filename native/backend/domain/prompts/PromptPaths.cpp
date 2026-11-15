#include "PromptPaths.h"

#include "../fs/PathPolicy.h"
#include "../../process/TextEncoding.h"

#include <QDir>
#include <QFileInfo>

#include <stdexcept>

namespace promptpaths {
namespace {

#ifdef Q_OS_WIN
constexpr Qt::CaseSensitivity kPathCase = Qt::CaseInsensitive;
#else
constexpr Qt::CaseSensitivity kPathCase = Qt::CaseSensitive;
#endif

[[noreturn]] void deny(const QString &reason)
{
    throw Denied{reason};
}

bool samePath(const QString &left, const QString &right)
{
    return left.compare(right, kPathCase) == 0;
}

/** `assertAuthorizedFilePath` equivalent: throws instead of returning a Result. */
QString authorizedFile(const QString &filePath, const QStringList &roots, const QString &operation,
                       pathpolicy::Mode mode)
{
    const pathpolicy::Result result = pathpolicy::assertAuthorized(filePath, roots, operation, mode);
    if (!result.ok) deny(operation);
    return result.path;
}

pathpolicy::Mode modeOf(const QString &mode)
{
    if (mode == QLatin1String("write")) return pathpolicy::Mode::Write;
    if (mode == QLatin1String("link")) return pathpolicy::Mode::Link;
    return pathpolicy::Mode::Read;
}

} // namespace

QString assertSinglePromptFileName(const QString &fileName)
{
    const QString name = fileName.trimmed();
    if (name.isEmpty() || name == QLatin1String(".") || name == QLatin1String("..")
        || name.contains(QLatin1Char('/')) || name.contains(QLatin1Char('\\'))
        || name.contains(QChar(0)) || QFileInfo(name).fileName() != name) {
        deny(QStringLiteral("prompt-file-name"));
    }
    return name;
}

QString assertDirectPromptFile(const QString &filePath, const QString &root, const QString &mode)
{
    if (filePath.isEmpty()) deny(QStringLiteral("prompt"));
    const QString rootReal = pathpolicy::existingRealPath(root);
    // A missing template root must fail closed: authorizing a path under a root that
    // does not exist yet would let the first write create it anywhere.
    if (rootReal.isEmpty()) deny(QStringLiteral("prompt"));

    const QString authorized = authorizedFile(filePath, QStringList{rootReal},
                                              QStringLiteral("prompt"), modeOf(mode));
    const QFileInfo target(QDir::cleanPath(filePath));
    const QString parentReal = pathpolicy::existingRealPath(target.path());
    if (parentReal.isEmpty() || !samePath(parentReal, rootReal)) deny(QStringLiteral("prompt"));

    const QString name = target.fileName();
    if (!name.endsWith(QLatin1String(".md")) || name.endsWith(QLatin1String(".d.md"))) {
        deny(QStringLiteral("prompt"));
    }
    return authorized;
}

QString assertProjectPromptRoot(const QString &projectRoot)
{
    const QString rootReal = pathpolicy::existingRealPath(projectRoot);
    if (rootReal.isEmpty()) deny(QStringLiteral("prompt-project"));

    const QString piPath = QDir(rootReal).filePath(QStringLiteral(".pi"));
    const QString piReal = pathpolicy::existingRealPath(piPath);
    const QFileInfo piInfo(piPath);
    // A valid intermediate link inside the project is allowed; a dangling link or one
    // that resolves outside the project is not.
    if ((piInfo.isSymLink() && piReal.isEmpty())
        || (!piReal.isEmpty() && !pathpolicy::isPathInsideRoot(piReal, rootReal))) {
        deny(QStringLiteral("prompt-project"));
    }

    const QString promptsPath = QDir(piPath).filePath(QStringLiteral("prompts"));
    const QString authorized = authorizedFile(promptsPath, QStringList{rootReal},
                                              QStringLiteral("prompt-project"),
                                              pathpolicy::Mode::Write);
    const QString promptsReal = pathpolicy::existingRealPath(authorized);
    if (!promptsReal.isEmpty() && !pathpolicy::isPathInsideRoot(promptsReal, rootReal)) {
        deny(QStringLiteral("prompt-project"));
    }
    return authorized;
}

QString assertRegisteredProjectRoot(const QString &projectPath, const QStringList &roots)
{
    if (projectPath.isEmpty()) deny(QStringLiteral("prompt-project"));
    QStringList existingRoots;
    for (const QString &root : roots) {
        if (root.isEmpty()) continue;
        const QString real = pathpolicy::existingRealPath(root);
        if (!real.isEmpty()) existingRoots.append(real);
    }
    if (existingRoots.isEmpty()) deny(QStringLiteral("prompt-project"));

    const QString authorized = authorizedFile(projectPath, existingRoots,
                                              QStringLiteral("prompt-project"),
                                              pathpolicy::Mode::Read);
    for (const QString &root : existingRoots) {
        if (samePath(root, authorized)) return authorized;
    }
    deny(QStringLiteral("prompt-project"));
}

Authorizer::Authorizer(QString globalRoot, ProjectRoots projectRoots, Translate translate)
    : m_globalRoot(std::move(globalRoot)), m_projectRoots(std::move(projectRoots)),
      m_translate(std::move(translate))
{
}

QString Authorizer::global(const QString &filePath, const QString &mode) const
{
    try {
        return assertDirectPromptFile(filePath, m_globalRoot, mode);
    } catch (const Denied &) {
        throw textenc::error(m_translate(mode == QLatin1String("link")
                                             ? QStringLiteral("mainPrompt.globalDeleteOnly")
                                             : QStringLiteral("mainPrompt.globalEditOnly"),
                                         QJsonObject{}));
    }
}

QString Authorizer::projectDirectory(const QString &projectPath) const
{
    try {
        const QString projectRoot = assertRegisteredProjectRoot(projectPath, m_projectRoots());
        return assertProjectPromptRoot(projectRoot);
    } catch (const Denied &) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.notAuthorized"), QJsonObject{}));
    }
}

QString Authorizer::readable(const QString &filePath) const
{
    bool globalDenied = false;
    try {
        return assertDirectPromptFile(filePath, m_globalRoot, QStringLiteral("read"));
    } catch (const Denied &) {
        globalDenied = true;
    }
    if (globalDenied) {
        for (const QString &root : m_projectRoots()) {
            try {
                const QString projectRoot = assertRegisteredProjectRoot(root, QStringList{root});
                const QString promptRoot = assertProjectPromptRoot(projectRoot);
                return assertDirectPromptFile(filePath, promptRoot, QStringLiteral("read"));
            } catch (const Denied &) {
                // Not this project's template; keep looking.
            }
        }
    }
    throw textenc::error(m_translate(QStringLiteral("mainPrompt.notAuthorized"), QJsonObject{}));
}

} // namespace promptpaths
