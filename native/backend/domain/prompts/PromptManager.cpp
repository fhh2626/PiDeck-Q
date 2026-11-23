#include "PromptManager.h"

#include "PromptBuiltins.h"

#include "../fs/FileOperations.h"
#include "../../process/TextEncoding.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>
#include <QSaveFile>

#include <algorithm>

namespace prompts {
namespace {

/** `description.replace(/^["']|["']$/g, "").trim()` — one leading and/or trailing quote. */
QString stripQuotes(const QString &value)
{
    QString text = value;
    if (!text.isEmpty() && (text.front() == QLatin1Char('"') || text.front() == QLatin1Char('\''))) {
        text.remove(0, 1);
    }
    if (!text.isEmpty() && (text.back() == QLatin1Char('"') || text.back() == QLatin1Char('\''))) {
        text.chop(1);
    }
    return text.trimmed();
}

/** First non-empty trimmed line, used when a file has no `description:` frontmatter. */
QString firstContentLine(const QString &raw)
{
    const QStringList lines = raw.split(QRegularExpression(QStringLiteral("\\r?\\n")));
    for (const QString &line : lines) {
        if (!line.trimmed().isEmpty()) return line.trimmed();
    }
    return {};
}

QString descriptionOf(const QString &raw)
{
    const QHash<QString, QString> frontmatter = Manager::parseFrontmatter(raw);
    // Only a *missing* key falls back to the first content line; an explicitly empty
    // `description:` stays empty, exactly like `??` in the oracle.
    if (frontmatter.contains(QStringLiteral("description"))) {
        return stripQuotes(frontmatter.value(QStringLiteral("description")));
    }
    return stripQuotes(firstContentLine(raw));
}

/** One `<name>.md` entry of a template directory. */
QVector<prompttpl::Template> scanDirectory(const QString &directory, const QString &scope,
                                           bool skipSymlinks)
{
    QVector<prompttpl::Template> templates;
    const QDir dir(directory);
    const QFileInfoList entries = dir.entryInfoList(QDir::Files | QDir::Hidden | QDir::System,
                                                    QDir::NoSort);
    for (const QFileInfo &entry : entries) {
        const QString fileName = entry.fileName();
        if (!fileName.endsWith(QLatin1String(".md"))) continue;
        // `.d.md` files are pi's description sidecars, not templates.
        if (fileName.endsWith(QLatin1String(".d.md"))) continue;
        if (skipSymlinks && entry.isSymLink()) continue;
        QFile file(entry.absoluteFilePath());
        if (!file.open(QIODevice::ReadOnly)) continue;
        const QString raw = QString::fromUtf8(file.readAll());
        if (raw.isEmpty()) continue;
        prompttpl::Template item;
        item.name = fileName.chopped(3);
        item.path = entry.absoluteFilePath();
        item.description = descriptionOf(raw);
        item.content = raw;
        item.userCreated = true;
        item.scope = scope;
        templates.append(item);
    }
    std::sort(templates.begin(), templates.end(),
              [](const prompttpl::Template &left, const prompttpl::Template &right) {
                  return left.name.localeAwareCompare(right.name) < 0;
              });
    return templates;
}

QString frontmatterBody(const QString &description)
{
    return QStringLiteral("---\ndescription: %1\n---\n")
        .arg(QString(description).replace(QLatin1Char('\n'), QLatin1Char(' ')));
}

/** Exclusive create: the syscall decides, so a concurrent import cannot clobber. */
void writeExclusive(const QString &path, const QString &content)
{
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::NewOnly)) {
        throw textenc::error(QStringLiteral("Unable to write %1").arg(path));
    }
    const QByteArray bytes = content.toUtf8();
    if (file.write(bytes) != bytes.size()) {
        file.close();
        throw textenc::error(QStringLiteral("Unable to write %1").arg(path));
    }
    file.close();
}

} // namespace

QHash<QString, QString> Manager::parseFrontmatter(const QString &raw)
{
    QHash<QString, QString> result;
    static const QRegularExpression pattern(QStringLiteral("^---\\r?\\n([\\s\\S]*?)\\r?\\n---"));
    const QRegularExpressionMatch match = pattern.match(raw);
    if (!match.hasMatch()) return result;
    const QStringList lines = match.captured(1).split(QRegularExpression(QStringLiteral("\\r?\\n")));
    for (const QString &line : lines) {
        const int index = line.indexOf(QLatin1Char(':'));
        if (index < 0) continue;
        const QString key = line.left(index).trimmed();
        if (key.isEmpty()) continue;
        result.insert(key, stripQuotes(line.mid(index + 1).trimmed()));
    }
    return result;
}

QString Manager::normalizeName(const QString &value)
{
    QString name = value.trimmed();
    static const QRegularExpression disallowed(QStringLiteral("[^\\p{L}\\p{N}-]"));
    name.replace(disallowed, QStringLiteral("-"));
    static const QRegularExpression repeated(QStringLiteral("-+"));
    name.replace(repeated, QStringLiteral("-"));
    while (name.startsWith(QLatin1Char('-'))) name.remove(0, 1);
    while (name.endsWith(QLatin1Char('-'))) name.chop(1);
    return name.toLower();
}

Manager::Manager(QString promptsDir, promptpaths::ProjectRoots projectRoots, HiddenStore hidden,
                 maincopy::Translator translate)
    : m_promptsDir(promptsDir), m_localPromptsDir(std::move(promptsDir)),
      m_authorizer(m_promptsDir, std::move(projectRoots), translate),
      m_hidden(std::move(hidden)), m_translate(std::move(translate))
{
}

void Manager::configureWsl(const wsl::Environment *environment)
{
    const QString globalDir = environment && environment->isValid()
        ? QDir(environment->windowsHome).filePath(QStringLiteral(".pi/agent/prompts"))
        : m_localPromptsDir;
    m_promptsDir = globalDir;
    // The authorizer holds its own copy of the root, so a switch that only updated the
    // manager would keep authorizing the previous environment's files.
    m_authorizer.setGlobalRoot(m_promptsDir);
}

QString Manager::ensureDir() const
{
    QDir().mkpath(m_promptsDir);
    return m_promptsDir;
}

QStringList Manager::hiddenBuiltinNames() const
{
    if (!m_hidden.read) return {};
    const QStringList known = promptbuiltins::names();
    QStringList names;
    for (const QString &value : m_hidden.read()) {
        const QString name = value.trimmed();
        // An unknown or duplicated name is dropped: the list only ever describes the
        // templates this build actually ships.
        if (name.isEmpty() || !known.contains(name) || names.contains(name)) continue;
        names.append(name);
    }
    return names;
}

bool Manager::hasHiddenBuiltins() const
{
    return !hiddenBuiltinNames().isEmpty();
}

void Manager::writeHidden(const QStringList &names) const
{
    if (m_hidden.write) m_hidden.write(names);
}

void Manager::restoreHiddenBuiltins() const
{
    if (!hasHiddenBuiltins()) return;
    writeHidden({});
}

void Manager::hideBuiltin(const QString &name) const
{
    const QString trimmed = name.trimmed();
    if (!promptbuiltins::isBuiltinName(trimmed)) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.fileNotFound"), QJsonObject{}));
    }
    QStringList current = hiddenBuiltinNames();
    if (current.contains(trimmed)) return;
    current.append(trimmed);
    writeHidden(current);
}

prompttpl::ListResult Manager::list() const
{
    prompttpl::ListResult result;
    ensureDir();
    result.templates = scanDirectory(m_promptsDir, QStringLiteral("global"), false);

    QStringList userNames;
    for (const prompttpl::Template &item : result.templates) userNames.append(item.name);
    const QStringList hidden = hiddenBuiltinNames();
    for (const promptbuiltins::Builtin &builtin : promptbuiltins::all()) {
        if (userNames.contains(builtin.name) || hidden.contains(builtin.name)) continue;
        prompttpl::Template item;
        item.name = builtin.name;
        item.path = prompttpl::builtinPrefix() + builtin.name;
        item.description = builtin.description;
        item.content = builtin.content;
        item.userCreated = false;
        item.scope = QStringLiteral("global");
        result.templates.append(item);
    }
    std::sort(result.templates.begin(), result.templates.end(),
              [](const prompttpl::Template &left, const prompttpl::Template &right) {
                  return left.name.localeAwareCompare(right.name) < 0;
              });
    result.globalDir = m_promptsDir;
    result.hasHiddenBuiltins = !hidden.isEmpty();
    return result;
}

prompttpl::Template Manager::create(const QString &rawName, const QString &rawDescription) const
{
    const QString name = normalizeName(rawName);
    if (name.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.nameRequiredDetailed"), QJsonObject{}));
    }
    const QString description = rawDescription.trimmed();
    if (description.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.descriptionRequired"), QJsonObject{}));
    }
    ensureDir();
    const QString filePath = QDir(m_promptsDir).filePath(name + QStringLiteral(".md"));
    const QString content = frontmatterBody(description);
    if (QFileInfo::exists(filePath)) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.alreadyExists"),
                                         QJsonObject{{QStringLiteral("name"), name}}));
    }
    writeExclusive(filePath, content);

    prompttpl::Template item;
    item.name = name;
    item.path = filePath;
    item.description = description;
    item.content = content;
    item.userCreated = true;
    return item;
}

DeleteTarget Manager::prepareDelete(const QString &filePath) const
{
    if (prompttpl::isBuiltinPath(filePath)) {
        hideBuiltin(prompttpl::builtinName(filePath));
        DeleteTarget target;
        target.handledInSettings = true;
        return target;
    }
    const QString authorized = m_authorizer.global(filePath, QStringLiteral("link"));
    if (!QFileInfo::exists(authorized)) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.fileNotFound"), QJsonObject{}));
    }
    return DeleteTarget{false, authorized, QStringLiteral("prompts:delete")};
}

QString Manager::requireProjectPromptsDir(const QString &projectPath) const
{
    return m_authorizer.projectDirectory(projectPath);
}

prompttpl::ListResult Manager::listByProject(const QString &projectPath) const
{
    prompttpl::ListResult result;
    const QString directory = requireProjectPromptsDir(projectPath);
    // Project templates are read-only from the list's point of view: a symlink entry
    // would import content from outside the project into the composer.
    result.templates = scanDirectory(directory, QStringLiteral("project"), true);
    result.globalDir = directory;
    // The built-in catalogue is global-only, so a project list never offers restore.
    result.hasHiddenBuiltins = false;
    return result;
}

prompttpl::Template Manager::createInProject(const QString &projectPath, const QString &rawName,
                                             const QString &rawDescription) const
{
    const QString directory = requireProjectPromptsDir(projectPath);
    QDir().mkpath(directory);
    const QString name = normalizeName(rawName);
    if (name.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.nameRequiredDetailed"), QJsonObject{}));
    }
    const QString description = rawDescription.trimmed();
    if (description.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.descriptionRequired"), QJsonObject{}));
    }
    const QString filePath = promptpaths::assertDirectPromptFile(
        QDir(directory).filePath(name + QStringLiteral(".md")), directory, QStringLiteral("write"));
    if (QFileInfo::exists(filePath)) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.alreadyExists"),
                                         QJsonObject{{QStringLiteral("name"), name}}));
    }
    const QString content = frontmatterBody(description);
    writeExclusive(filePath, content);

    prompttpl::Template item;
    item.name = name;
    item.path = filePath;
    item.description = description;
    item.content = content;
    item.userCreated = true;
    item.scope = QStringLiteral("project");
    return item;
}

DeleteTarget Manager::prepareDeleteInProject(const QString &projectPath, const QString &fileName) const
{
    const QString safeName = promptpaths::assertSinglePromptFileName(fileName);
    const QString directory = requireProjectPromptsDir(projectPath);
    const QString filePath = promptpaths::assertDirectPromptFile(
        QDir(directory).filePath(safeName), directory, QStringLiteral("link"));
    if (!QFileInfo::exists(filePath)) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.fileNotFound"), QJsonObject{}));
    }
    return DeleteTarget{false, filePath, QStringLiteral("prompts:delete-project")};
}

QString Manager::readContent(const QString &filePath) const
{
    const QString authorized = m_authorizer.readable(filePath);
    QFile file(authorized);
    if (!file.open(QIODevice::ReadOnly)) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.fileNotFound"), QJsonObject{}));
    }
    return QString::fromUtf8(file.readAll());
}

void Manager::writeContent(const QString &filePath, const QString &content) const
{
    const QString authorized = m_authorizer.global(filePath, QStringLiteral("write"));
    QSaveFile file(authorized);
    if (!file.open(QIODevice::WriteOnly)) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.globalEditOnly"), QJsonObject{}));
    }
    const QByteArray bytes = content.toUtf8();
    if (file.write(bytes) != bytes.size() || !file.commit()) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.globalEditOnly"), QJsonObject{}));
    }
}

namespace {

/** Shared rename body: authorize both sides, then move without clobbering. */
prompttpl::Template renameTemplate(const QString &oldPath, const QString &newPath,
                                   const QString &newName, const QString &scope,
                                   const maincopy::Translator &translate)
{
    // No existence pre-check on the target: the check and the rename are not atomic,
    // so the rename itself must be the authority on conflicts.
    try {
        fsops::renameEntry(oldPath, QFileInfo(newPath).fileName());
    } catch (const std::exception &failure) {
        const QString message = QString::fromUtf8(failure.what());
        if (message.startsWith(QLatin1String(fsops::kRenameTargetExistsCode))) {
            throw textenc::error(translate(QStringLiteral("mainPrompt.alreadyExists"),
                                           QJsonObject{{QStringLiteral("name"), newName}}));
        }
        throw;
    }
    QFile file(newPath);
    if (!file.open(QIODevice::ReadOnly)) {
        throw textenc::error(translate(QStringLiteral("mainPrompt.fileNotFound"), QJsonObject{}));
    }
    const QString raw = QString::fromUtf8(file.readAll());
    prompttpl::Template item;
    item.name = newName;
    item.path = newPath;
    item.description = descriptionOf(raw);
    item.content = raw;
    item.userCreated = true;
    item.scope = scope;
    return item;
}

} // namespace

prompttpl::Template Manager::rename(const QString &rawOld, const QString &rawNew) const
{
    const QString oldName = normalizeName(rawOld);
    const QString newName = normalizeName(rawNew);
    if (oldName.isEmpty() || newName.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.nameRequired"), QJsonObject{}));
    }
    if (oldName == newName) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.sameName"), QJsonObject{}));
    }
    const QString oldPath = m_authorizer.global(
        QDir(m_promptsDir).filePath(oldName + QStringLiteral(".md")), QStringLiteral("read"));
    const QString newPath = m_authorizer.global(
        QDir(m_promptsDir).filePath(newName + QStringLiteral(".md")), QStringLiteral("write"));
    if (!QFileInfo::exists(oldPath)) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.notFound"),
                                         QJsonObject{{QStringLiteral("name"), rawOld}}));
    }
    return renameTemplate(oldPath, newPath, newName, QStringLiteral("global"), m_translate);
}

prompttpl::Template Manager::renameInProject(const QString &projectPath, const QString &rawOld,
                                             const QString &rawNew) const
{
    const QString directory = requireProjectPromptsDir(projectPath);
    const QString oldName = normalizeName(rawOld);
    const QString newName = normalizeName(rawNew);
    if (oldName.isEmpty() || newName.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.nameRequired"), QJsonObject{}));
    }
    if (oldName == newName) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.sameName"), QJsonObject{}));
    }
    const QString oldPath = promptpaths::assertDirectPromptFile(
        QDir(directory).filePath(oldName + QStringLiteral(".md")), directory, QStringLiteral("read"));
    const QString newPath = promptpaths::assertDirectPromptFile(
        QDir(directory).filePath(newName + QStringLiteral(".md")), directory, QStringLiteral("write"));
    if (!QFileInfo::exists(oldPath)) {
        throw textenc::error(m_translate(QStringLiteral("mainPrompt.notFound"),
                                         QJsonObject{{QStringLiteral("name"), rawOld}}));
    }
    return renameTemplate(oldPath, newPath, newName, QStringLiteral("project"), m_translate);
}

} // namespace prompts
