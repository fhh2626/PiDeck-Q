#include "ExtensionManager.h"

#include "BuiltInExtensions.h"
#include "PiCli.h"

#include "../fs/EntryLink.h"
#include "../fs/JsonFile.h"
#include "../../process/TextEncoding.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QRegularExpression>
#include <QSet>

#include <algorithm>

namespace extensions {
namespace {

/** pi appends this to a filtered package's source in `pi list` output. */
const QString kFilteredSuffix = QStringLiteral(" (filtered)");
constexpr int kListTimeoutMs = 20'000;
constexpr int kRemoveTimeoutMs = 30'000;
constexpr int kInstallTimeoutMs = 60'000;
constexpr int kUpdateTimeoutMs = 120'000;

bool hasProtocolPrefix(const QString &source)
{
    static const QRegularExpression pattern(QStringLiteral("^(?:npm|file|github|git|https?):"),
                                            QRegularExpression::CaseInsensitiveOption);
    return pattern.match(source).hasMatch();
}

/** Semver-ish comparison: numeric segments, non-numeric parts count as 0. */
int compareVersions(const QString &left, const QString &right)
{
    auto parts = [](const QString &value) {
        QString text = value;
        if (text.startsWith(QLatin1Char('v'), Qt::CaseInsensitive)) text.remove(0, 1);
        QStringList split = text.split(QRegularExpression(QStringLiteral("[.-]")));
        QVector<int> numbers;
        for (const QString &part : split) numbers.append(part.toInt());
        return numbers;
    };
    const QVector<int> a = parts(left);
    const QVector<int> b = parts(right);
    const int length = std::max(a.size(), b.size());
    for (int index = 0; index < length; ++index) {
        const int diff = (index < a.size() ? a.at(index) : 0) - (index < b.size() ? b.at(index) : 0);
        if (diff != 0) return diff;
    }
    return 0;
}

} // namespace

QJsonObject summaryToJson(const Summary &extension)
{
    QJsonObject object{
        {QStringLiteral("id"), extension.id},
        {QStringLiteral("source"), extension.source},
        {QStringLiteral("scope"), extension.scope},
        {QStringLiteral("enabled"), extension.enabled},
    };
    if (extension.builtInSet) object.insert(QStringLiteral("builtIn"), extension.builtIn);
    // `path` is optional in the oracle's type; an absent path must stay absent so the
    // renderer's "open folder" action is disabled instead of opening an empty string.
    if (!extension.path.isEmpty()) object.insert(QStringLiteral("path"), extension.path);
    if (extension.filtered) object.insert(QStringLiteral("filtered"), true);
    if (!extension.currentVersion.isEmpty()) {
        object.insert(QStringLiteral("currentVersion"), extension.currentVersion);
    }
    if (!extension.latestVersion.isEmpty()) {
        object.insert(QStringLiteral("latestVersion"), extension.latestVersion);
    }
    if (extension.hasUpdate) object.insert(QStringLiteral("hasUpdate"), true);
    if (!extension.updateError.isEmpty()) {
        object.insert(QStringLiteral("updateError"), extension.updateError);
    }
    return object;
}

QJsonObject listToJson(const ListResult &result)
{
    QJsonArray items;
    for (const Summary &extension : result.extensions) items.append(summaryToJson(extension));
    QJsonObject object{
        {QStringLiteral("extensions"), items},
        {QStringLiteral("raw"), result.raw},
    };
    if (!result.conflicts.isEmpty()) {
        QJsonArray conflicts;
        for (const Conflict &conflict : result.conflicts) {
            conflicts.append(QJsonObject{{QStringLiteral("builtIn"), conflict.builtIn},
                                         {QStringLiteral("thirdParty"), conflict.thirdParty}});
        }
        object.insert(QStringLiteral("conflicts"), conflicts);
    }
    return object;
}

Manager::Manager(QString agentDir, SettingsProvider settings, SettingsPatcher patch,
                 maincopy::Translator translate)
    : m_agentDir(agentDir), m_localAgentDir(std::move(agentDir)), m_settings(std::move(settings)),
      m_patch(std::move(patch)), m_translate(std::move(translate))
{
}

void Manager::configureWsl(const wsl::Environment *environment)
{
    m_agentDir = environment && environment->isValid()
        ? QDir(environment->windowsHome).filePath(QStringLiteral(".pi/agent"))
        : m_localAgentDir;
    // A cached list belongs to the previous extension directory.
    invalidate();
}

QString Manager::extensionsDir() const
{
    return QDir(m_agentDir).filePath(QStringLiteral("extensions"));
}

QString Manager::piSettingsPath() const
{
    return QDir(m_agentDir).filePath(QStringLiteral("settings.json"));
}

void Manager::invalidate()
{
    m_hasCache = false;
    m_generation += 1;
}

QStringList Manager::removedBuiltIn() const
{
    QStringList names;
    if (!m_settings) return names;
    const QJsonArray array = m_settings().value(QStringLiteral("removedBuiltInExtensions")).toArray();
    for (const QJsonValue &value : array) {
        if (value.isString()) names.append(value.toString());
    }
    return names;
}

void Manager::saveRemovedBuiltIn(const QStringList &names)
{
    if (!m_patch) return;
    m_patch(QJsonObject{{QStringLiteral("removedBuiltInExtensions"),
                         QJsonArray::fromStringList(names)}});
}

QStringList Manager::disabledExtensions() const
{
    QJsonValue value;
    if (jsonfile::readJson(piSettingsPath(), &value, nullptr) != jsonfile::ReadState::Ok) return {};
    QStringList disabled;
    for (const QJsonValue &entry : value.toObject().value(QStringLiteral("disabledExtensions")).toArray()) {
        if (entry.isString()) disabled.append(entry.toString());
    }
    return disabled;
}

void Manager::writePiSettings(const QStringList &disabled) const
{
    QJsonValue existing;
    QJsonObject settings;
    if (jsonfile::readJson(piSettingsPath(), &existing, nullptr) == jsonfile::ReadState::Ok) {
        settings = existing.toObject();
    }
    // pi's settings.json is a user file: keep every unrelated key and replace only the
    // list this domain owns.
    settings.insert(QStringLiteral("disabledExtensions"), QJsonArray::fromStringList(disabled));
    QString error;
    if (!jsonfile::writeJsonAtomic(piSettingsPath(), settings, &error)) {
        throw textenc::error(QStringLiteral("Unable to write pi settings: %1").arg(error));
    }
}

QVector<Summary> Manager::parseListOutput(const QString &raw) const
{
    QVector<Summary> result;
    QString scope = QStringLiteral("unknown");
    int pending = -1;
    const QStringList lines = raw.split(QRegularExpression(QStringLiteral("\\r?\\n")));
    for (const QString &line : lines) {
        const QString trimmed = line.trimmed();
        if (trimmed.isEmpty()) continue;
        if (trimmed.startsWith(QLatin1String("User packages:"), Qt::CaseInsensitive)) {
            scope = QStringLiteral("user");
            pending = -1;
            continue;
        }
        if (trimmed.startsWith(QLatin1String("Project packages:"), Qt::CaseInsensitive)) {
            scope = QStringLiteral("project");
            pending = -1;
            continue;
        }
        if (hasProtocolPrefix(trimmed)) {
            // The filtered marker must be stripped: remove/update/version lookups all
            // take the bare source and would otherwise not find the package.
            const bool filtered = trimmed.endsWith(kFilteredSuffix);
            const QString source = filtered ? trimmed.chopped(kFilteredSuffix.size()) : trimmed;
            Summary summary;
            summary.id = scope + QLatin1Char(':') + source;
            summary.source = source;
            summary.scope = scope;
            summary.filtered = filtered;
            result.append(summary);
            pending = result.size() - 1;
            continue;
        }
        if (pending >= 0 && result[pending].path.isEmpty()) result[pending].path = trimmed;
    }
    return result;
}

QVector<Summary> Manager::scanLocalExtensions() const
{
    QVector<Summary> result;
    const QDir directory(extensionsDir());
    const QFileInfoList entries = directory.entryInfoList(
        QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden, QDir::NoSort);
    for (const QFileInfo &entry : entries) {
        const QString name = entry.fileName();
        if (name.startsWith(QLatin1Char('.')) || name == QLatin1String("node_modules")
            || name.endsWith(QLatin1String(".d.ts"))) {
            continue;
        }
        QString source = name;
        if (name.endsWith(QLatin1String(".ts"))) {
            // Single-file extension: the display name drops the suffix, the source keeps it.
            source = name;
        } else {
            // Directory extension: only one with an index.ts is loadable by pi.
            if (!QFileInfo::exists(directory.filePath(name + QStringLiteral("/index.ts")))) continue;
        }
        Summary summary;
        summary.id = QStringLiteral("local:") + source;
        summary.source = source;
        summary.path = extensionsDir();
        summary.scope = QStringLiteral("user");
        summary.builtInSet = true;
        summary.builtIn = builtext::isBuiltInName(source);
        result.append(summary);
    }
    return result;
}

Summary Manager::enrichVersion(const Summary &extension) const
{
    if (!extension.source.startsWith(QLatin1String("npm:"), Qt::CaseInsensitive)) return extension;
    const QString packageName = extension.source.mid(4);
    Summary enriched = extension;
    QString currentVersion;
    if (!extension.path.isEmpty()) {
        QJsonValue package;
        if (jsonfile::readJson(QDir(extension.path).filePath(QStringLiteral("package.json")), &package,
                               nullptr)
            == jsonfile::ReadState::Ok) {
            currentVersion = package.toObject().value(QStringLiteral("version")).toString();
        }
    }
    const picli::Result latest = picli::runCommand(
        QStringLiteral("npm"), QStringList{QStringLiteral("view"), packageName, QStringLiteral("version")},
        30'000);
    if (!latest.ok()) {
        enriched.updateError = m_translate(QStringLiteral("mainExtension.versionCheckFailed"), {});
        return enriched;
    }
    enriched.currentVersion = currentVersion;
    enriched.latestVersion = latest.stdoutText.trimmed();
    enriched.hasUpdate = !currentVersion.isEmpty() && !enriched.latestVersion.isEmpty()
        && compareVersions(enriched.latestVersion, currentVersion) > 0;
    return enriched;
}

void Manager::removeBuiltInFile(const QString &source) const
{
    const QString trimmed = source.trimmed();
    // Only a shipped basename may be removed; this is the traversal guard.
    if (QFileInfo(trimmed).fileName() != trimmed || !builtext::isBuiltInName(trimmed)) {
        throw textenc::error(QStringLiteral("Invalid built-in extension path"));
    }
    // This deletes a stale deployment copy of a built-in PiDeck itself ships, not user content,
    // so a hard remove matches the oracle: `rm(target, { force: true })` - note the missing
    // `recursive` - where `force` only silences ENOENT for a missing entry.
    //
    // Non-recursive is load-bearing: the oracle's `rm` refuses a *directory* (unlink of a
    // directory fails with EISDIR/EPERM) and every caller swallows that, so a user directory
    // that happens to carry a built-in basename survives with all of its content. Recursive
    // deletion was never authorized parity - and `QDir::removeRecursively()` made it worse by
    // classifying a Windows junction as a plain directory, deleting the *referent's* content
    // before unlinking the link. `fsops::removeEntry` is the entry-level unlink: a link
    // (junction included) is removed as a link and its referent is never traversed.
    const QString target = QDir(extensionsDir()).filePath(trimmed);
    if (!fsops::entryExists(target)) return;
    if (!fsops::isLinkEntry(target) && fsops::isRealDirectory(target)) {
        // Oracle: a directory is refused (the empty case too - `rm` still unlinks, and unlink
        // of a directory fails), so the user's directory and its content stay untouched.
        throw textenc::error(QStringLiteral("Unable to remove %1").arg(target));
    }
    if (!fsops::removeEntry(target)) {
        throw textenc::error(QStringLiteral("Unable to remove %1").arg(target));
    }
}

ListResult Manager::loadList(bool includeVersionInfo)
{
    const picli::Result raw = picli::run(
        m_settings ? m_settings() : QJsonObject{}, QStringList{QStringLiteral("list")},
        kListTimeoutMs, true);
    if (!raw.ok()) {
        throw textenc::error(m_translate(QStringLiteral("mainExtension.commandFailed"), {}));
    }
    QVector<Summary> parsed = parseListOutput(raw.stdoutText);
    if (includeVersionInfo) {
        for (Summary &extension : parsed) extension = enrichVersion(extension);
    }

    // `pi list` only reports packages installed through the CLI; a hand-dropped `.ts`
    // file in the auto-discovery directory is a real extension too.
    QSet<QString> installedPaths;
    for (const Summary &extension : parsed) {
        if (!extension.path.isEmpty()) installedPaths.insert(extension.path);
    }
    QVector<Summary> merged = parsed;
    for (const Summary &local : scanLocalExtensions()) {
        if (!local.path.isEmpty() && installedPaths.contains(local.path)) continue;
        merged.append(local);
    }

    // A disabled or missing built-in must still be listed so it can be re-enabled.
    QSet<QString> existingSources;
    for (const Summary &extension : merged) existingSources.insert(extension.source);
    for (const QString &name : builtext::names()) {
        if (existingSources.contains(name)) continue;
        Summary summary;
        summary.id = QStringLiteral("local:") + name;
        summary.source = name;
        summary.scope = QStringLiteral("user");
        summary.builtInSet = true;
        summary.builtIn = true;
        merged.append(summary);
    }

    QStringList removed = removedBuiltIn();
    const QStringList disabledList = disabledExtensions();
    const QSet<QString> disabled(disabledList.begin(), disabledList.end());
    for (Summary &extension : merged) {
        extension.enabled = extension.builtIn ? !removed.contains(extension.source)
                                              : !disabled.contains(extension.source);
    }

    // A third-party package that implements the same feature as a built-in replaces it;
    // otherwise pi would load two todo/plan/ask extensions at once.
    QVector<Conflict> conflicts;
    bool removedChanged = false;
    for (const QString &builtInName : builtext::conflictKeywords()) {
        if (removed.contains(builtInName)) continue;
        QString conflicting;
        for (const Summary &extension : merged) {
            if (extension.builtIn || !extension.enabled) continue;
            if (builtext::findConflict(QStringList{extension.source}, builtInName).isEmpty()) continue;
            conflicting = extension.source;
            break;
        }
        if (conflicting.isEmpty()) continue;
        removed.append(builtInName);
        removedChanged = true;
        // Best effort: the user copy may already be gone.
        try {
            removeBuiltInFile(builtInName);
        } catch (const std::exception &) {
        }
        for (Summary &extension : merged) {
            if (extension.builtIn && extension.source == builtInName) extension.enabled = false;
        }
        conflicts.append(Conflict{builtInName, conflicting});
    }
    if (removedChanged) saveRemovedBuiltIn(removed);

    // A built-in that is already marked removed but still on disk would keep loading.
    for (const QString &name : removed) {
        if (!builtext::isBuiltInName(name)) continue;
        try {
            removeBuiltInFile(name);
        } catch (const std::exception &) {
        }
    }

    ListResult result;
    result.extensions = merged;
    result.raw = raw.stdoutText;
    result.conflicts = conflicts;
    return result;
}

ListResult Manager::list(bool forceRefresh)
{
    // A lightweight list reuses the cache; an explicit refresh must really re-scan,
    // otherwise repeated clicks keep showing the same npm versions.
    if (m_hasCache && !forceRefresh) return m_cache;

    const int generation = m_generation;
    ListResult result = loadList(forceRefresh);
    if (generation != m_generation) {
        // A mutation happened while this scan ran: the caller must see the new state,
        // not the pre-mutation snapshot.
        return list(forceRefresh);
    }
    m_cache = result;
    m_hasCache = true;
    return result;
}

QString Manager::install(const QString &rawSource)
{
    const QString source = rawSource.trimmed();
    if (source.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainExtension.nameRequired"), {}));
    }
    const picli::Result result = picli::run(
        m_settings ? m_settings() : QJsonObject{},
        QStringList{QStringLiteral("install"), source}, kInstallTimeoutMs, true);
    if (!result.ok()) {
        throw textenc::error(m_translate(QStringLiteral("mainExtension.commandFailed"), {}));
    }
    invalidate();
    return result.stdoutText;
}

QString Manager::localExtensionToTrash(const QString &source) const
{
    const QString trimmed = source.trimmed();
    const QString name = QFileInfo(trimmed).fileName();
    // The source must be exactly one directory entry: no `..`, no absolute path.
    if (name.isEmpty() || name != trimmed || name == QLatin1String(".")
        || name == QLatin1String("..")) {
        throw textenc::error(m_translate(QStringLiteral("mainExtension.invalidPath"), {}));
    }
    return QDir(extensionsDir()).filePath(name);
}

void Manager::clearDisabledEntry(const QString &source) const
{
    const QStringList disabled = disabledExtensions();
    if (!disabled.contains(source)) return;
    QStringList next = disabled;
    next.removeAll(source);
    writePiSettings(next);
}

QString Manager::uninstall(const QString &rawSource, const QString &scope)
{
    const QString source = rawSource.trimmed();
    if (source.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainExtension.sourceRequired"), {}));
    }
    if (builtext::isBuiltInName(source) || source.startsWith(QLatin1String("pi-deck-"))) {
        throw textenc::error(m_translate(QStringLiteral("mainExtension.builtInCannotUninstall"), {}));
    }
    QString trashTarget;
    if (!hasProtocolPrefix(source)) {
        // A local file extension is not a pi package; `pi remove` would answer
        // "No matching package", so the file itself is the target.
        trashTarget = localExtensionToTrash(source);
    } else {
        QStringList arguments{QStringLiteral("remove"), source};
        if (scope == QLatin1String("project")) arguments.append(QStringLiteral("-l"));
        const picli::Result result = picli::run(m_settings ? m_settings() : QJsonObject{}, arguments,
                                                kRemoveTimeoutMs, true);
        if (!result.ok()) {
            throw textenc::error(m_translate(QStringLiteral("mainExtension.commandFailed"), {}));
        }
    }
    clearDisabledEntry(source);
    invalidate();
    return trashTarget;
}

void Manager::setEnabled(const QString &source, bool enabled)
{
    QStringList disabled = disabledExtensions();
    if (enabled) disabled.removeAll(source);
    else if (!disabled.contains(source)) disabled.append(source);
    writePiSettings(disabled);
    invalidate();
}

void Manager::disableBuiltIn(const QString &rawSource)
{
    const QString source = rawSource.trimmed();
    if (!builtext::isBuiltInName(source)) {
        throw textenc::error(QStringLiteral("Only a built-in extension can be toggled here"));
    }
    QStringList removed = removedBuiltIn();
    if (!removed.contains(source)) {
        removed.append(source);
        saveRemovedBuiltIn(removed);
    }
    // Idempotent cleanup of a historical deployment copy; the new path never writes one.
    try {
        removeBuiltInFile(source);
    } catch (const std::exception &) {
    }
    invalidate();
}

void Manager::removeBuiltIn(const QString &source)
{
    disableBuiltIn(source);
}

void Manager::restoreBuiltIn(const QString &rawSource)
{
    const QString source = rawSource.trimmed();
    if (!builtext::isBuiltInName(source)) {
        throw textenc::error(QStringLiteral("Only a built-in extension can be toggled here"));
    }
    QStringList removed = removedBuiltIn();
    if (!removed.contains(source)) return;
    removed.removeAll(source);
    saveRemovedBuiltIn(removed);
    try {
        removeBuiltInFile(source);
    } catch (const std::exception &) {
    }
    invalidate();
}

UpdateResult Manager::updateAll()
{
    const picli::Result result = picli::run(
        m_settings ? m_settings() : QJsonObject{},
        QStringList{QStringLiteral("update"), QStringLiteral("--extensions")}, kUpdateTimeoutMs,
        false);
    if (!result.ok()) {
        throw textenc::error(m_translate(QStringLiteral("mainExtension.commandFailed"), {}));
    }
    invalidate();
    return UpdateResult{QStringLiteral("pi update --extensions"), result.stdoutText.trimmed(), true};
}

UpdateResult Manager::updateOne(const QString &rawSource)
{
    const QString source = rawSource.trimmed();
    const picli::Result result = picli::run(
        m_settings ? m_settings() : QJsonObject{},
        QStringList{QStringLiteral("update"), source}, kUpdateTimeoutMs, false);
    if (!result.ok()) {
        throw textenc::error(m_translate(QStringLiteral("mainExtension.commandFailed"), {}));
    }
    invalidate();
    return UpdateResult{QStringLiteral("pi update %1").arg(source), result.stdoutText.trimmed(), true};
}

} // namespace extensions
