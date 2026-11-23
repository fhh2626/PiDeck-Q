#include "SettingsCatalog.h"

#include "JsonFile.h"
#include "MainCopy.h"

#include <algorithm>
#include <cmath>

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonValue>
#include <QLocale>
#include <QRandomGenerator>
#include <QRegularExpression>

namespace {

const QStringList kLegacyKeys = {
    QStringLiteral("telemetryEnabled"),
    QStringLiteral("telemetryInstallId"),
    QStringLiteral("telemetryLastHeartbeatDate"),
    QStringLiteral("linkOpenMode"),
    QStringLiteral("electronChromiumSandbox"),
    QStringLiteral("disableUpdateCheck"),
    QStringLiteral("rpcTimeout"),
};

/** Built-in extensions that ship disabled, and the version that tracks the migration. */
const QStringList kDefaultDisabledBuiltIns = {
    QStringLiteral("pideck-q-websearch.ts"),
    QStringLiteral("pideck-q-better-compaction.ts"),
};
constexpr int kBuiltInDefaultsVersion = 4;

/** File renames only migrate the persisted identity, never the user's enable/disable. */
const QHash<QString, QString> &builtInAliases()
{
    static const QHash<QString, QString> aliases = {
        {QStringLiteral("pi-deck-ask-question.ts"), QStringLiteral("pideck-q-ask-question.ts")},
        {QStringLiteral("pi-deck-websearch.ts"), QStringLiteral("pideck-q-websearch.ts")},
        {QStringLiteral("pi-better-compaction.ts"), QStringLiteral("pideck-q-better-compaction.ts")},
    };
    return aliases;
}

QJsonObject editorDefaults()
{
    QJsonObject editors;
    const QStringList ids = {
        QStringLiteral("vscode"),     QStringLiteral("cursor"), QStringLiteral("zed"),
        QStringLiteral("sublime"),    QStringLiteral("idea"),   QStringLiteral("webstorm"),
        QStringLiteral("phpstorm"),   QStringLiteral("pycharm"),
    };
    for (const QString &id : ids) {
        editors.insert(id, QJsonObject{{QStringLiteral("enabled"), false},
                                       {QStringLiteral("command"), QStringLiteral("")}});
    }
    return editors;
}

QJsonObject defaultSettings()
{
    return QJsonObject{
        {QStringLiteral("useNativeTitleBar"), true},
        {QStringLiteral("showNativeMenu"), false},
        {QStringLiteral("sendShortcut"), QStringLiteral("enter-send")},
        {QStringLiteral("theme"), QStringLiteral("system")},
        {QStringLiteral("accent"), QStringLiteral("default")},
        {QStringLiteral("themeSkin"), QStringLiteral("classic-green")},
        {QStringLiteral("customThemeOverrides"), QJsonObject{}},
        {QStringLiteral("backgroundImage"), QStringLiteral("")},
        {QStringLiteral("backgroundImageOpacity"), 0.8},
        {QStringLiteral("language"), QStringLiteral("system")},
        {QStringLiteral("startupWindowMode"), QStringLiteral("last")},
        {QStringLiteral("piEnvironmentChecked"), false},
        {QStringLiteral("piRuntimePreference"), QStringLiteral("auto")},
        {QStringLiteral("piTypescriptPath"), QStringLiteral("")},
        {QStringLiteral("piBoltPath"), QStringLiteral("")},
        {QStringLiteral("enableGitManagement"), true},
        // Localized on load so a fresh install matches the UI language.
        {QStringLiteral("gitCommitMessagePrompt"), defaultGitCommitMessagePromptFor(QStringLiteral("zh-CN"))},
        {QStringLiteral("gitCommitMessageProvider"), QStringLiteral("")},
        {QStringLiteral("gitCommitMessageModel"), QStringLiteral("")},
        {QStringLiteral("closeToTray"), true},
        {QStringLiteral("singleInstance"), true},
        {QStringLiteral("enableNotifications"), true},
        {QStringLiteral("agentCountReminderEnabled"), true},
        {QStringLiteral("showThinking"), true},
        {QStringLiteral("expandInterimDuringStream"), false},
        {QStringLiteral("collapsePrevRunsOnNewTurn"), true},
        {QStringLiteral("showDevTools"), false},
        {QStringLiteral("piProxyEnabled"), false},
        {QStringLiteral("piProxyUrl"), QStringLiteral("http://127.0.0.1:7890")},
        {QStringLiteral("piProxyBypass"), QStringLiteral("localhost,127.0.0.1,::1")},
        {QStringLiteral("desktopProxyEnabled"), false},
        {QStringLiteral("desktopProxyUrl"), QStringLiteral("http://127.0.0.1:7890")},
        {QStringLiteral("desktopProxyBypass"), QStringLiteral("localhost,127.0.0.1,::1")},
        {QStringLiteral("customPiPath"), QStringLiteral("")},
        {QStringLiteral("wslEnabled"), false},
        {QStringLiteral("wslDistro"), QStringLiteral("Ubuntu")},
        {QStringLiteral("wslUser"), QStringLiteral("root")},
        {QStringLiteral("webServiceEnabled"), false},
        {QStringLiteral("webServiceHost"), QStringLiteral("0.0.0.0")},
        {QStringLiteral("webServicePort"), 8765},
        {QStringLiteral("webServiceAccessToken"), QStringLiteral("")},
        {QStringLiteral("workspaceContentOpenMode"), QStringLiteral("split")},
        {QStringLiteral("contentMaxWidth"), 1800},
        {QStringLiteral("chatContentWidthPct"), 80},
        {QStringLiteral("maxEditorFileSizeMB"), 5},
        {QStringLiteral("externalEditors"), editorDefaults()},
        {QStringLiteral("favoriteModels"), QJsonArray{}},
        {QStringLiteral("removedBuiltInExtensions"), QJsonArray::fromStringList(kDefaultDisabledBuiltIns)},
        {QStringLiteral("builtInExtensionDefaultsVersion"), kBuiltInDefaultsVersion},
        {QStringLiteral("hiddenBuiltinPromptNames"), QJsonArray{}},
        {QStringLiteral("piRpcOffline"), true},
        {QStringLiteral("piRpcNoExtensions"), false},
        {QStringLiteral("piRpcNoSkills"), false},
        {QStringLiteral("fontSize"), QStringLiteral("default")},
        {QStringLiteral("uiFontSize"), QJsonValue::Null},
        {QStringLiteral("chatFontSize"), QJsonValue::Null},
        {QStringLiteral("inputFontSize"), QJsonValue::Null},
        {QStringLiteral("chatBodyLineHeight"), QStringLiteral("default")},
        {QStringLiteral("chatBlockGap"), QStringLiteral("default")},
        {QStringLiteral("chatListDensity"), QStringLiteral("default")},
        {QStringLiteral("chatCodeDensity"), QStringLiteral("default")},
        {QStringLiteral("zoomFactor"), 1},
        {QStringLiteral("fontFamilyBase"), QStringLiteral("system")},
        {QStringLiteral("fontFamilyBaseCustom"), QStringLiteral("")},
        {QStringLiteral("fontFamilyMono"), QStringLiteral("system-mono")},
        {QStringLiteral("fontFamilyMonoCustom"), QStringLiteral("")},
    };
}

QJsonObject mergeObjects(const QJsonObject &defaults, const QJsonObject &parsed)
{
    QJsonObject merged = defaults;
    for (auto it = parsed.begin(); it != parsed.end(); ++it) {
        if (kLegacyKeys.contains(it.key())) continue;
        if (it.key() == QLatin1String("externalEditors") && it.value().isObject()) {
            // SettingsStore.load() merges the editor map one level deep and replaces each
            // editor entry wholesale, so a persisted `{vscode: {enabled}}` drops the
            // default `command` field. Matching that keeps the object byte-identical.
            QJsonObject child = defaults.value(it.key()).toObject();
            const QJsonObject overrideObject = it.value().toObject();
            for (auto childIt = overrideObject.begin(); childIt != overrideObject.end(); ++childIt) {
                child.insert(childIt.key(), childIt.value());
            }
            merged.insert(it.key(), child);
        } else {
            merged.insert(it.key(), it.value());
        }
    }
    return merged;
}

QString agentSettingsPath(const QString &agentDir)
{
    const QString dir = agentDir.isEmpty() ? QDir(QDir::homePath()).filePath(QStringLiteral(".pi/agent"))
                                           : agentDir;
    return QDir(dir).filePath(QStringLiteral("settings.json"));
}

/** `showThinking = !hideThinkingBlock`; a missing file or field yields a null value. */
QJsonValue readPiShowThinking(const QString &agentDir)
{
    QJsonValue value;
    if (jsonfile::readJson(agentSettingsPath(agentDir), &value, nullptr) != jsonfile::ReadState::Ok) {
        return QJsonValue(QJsonValue::Null);
    }
    const QJsonValue hide = value.toObject().value(QStringLiteral("hideThinkingBlock"));
    if (!hide.isBool()) return QJsonValue(QJsonValue::Null);
    return QJsonValue(!hide.toBool());
}

QString systemLocaleName()
{
    return QLocale::system().name().replace(QLatin1Char('_'), QLatin1Char('-'));
}

maincopy::Locale resolvePromptLocale(const QString &language)
{
    const QString selected = language.isEmpty() || language == QStringLiteral("system")
        ? systemLocaleName()
        : language;
    const QString normalized = selected.trimmed().replace(QLatin1Char('_'), QLatin1Char('-')).toLower();
    return normalized == QStringLiteral("pseudo") || normalized.startsWith(QStringLiteral("en"))
        ? maincopy::Locale::EnUS
        : maincopy::Locale::ZhCN;
}

QString generateAccessToken()
{
    QByteArray bytes(32, 0);
    for (int index = 0; index < bytes.size(); ++index) {
        bytes[index] = char(QRandomGenerator::global()->bounded(256));
    }
    return QString::fromLatin1(bytes.toBase64(QByteArray::Base64UrlEncoding
                                              | QByteArray::OmitTrailingEquals));
}

/** `migrateBuiltInExtensionDefaults`: only newly-disabled defaults are added once. */
bool migrateBuiltInDefaults(QJsonObject *settings, const QJsonValue &persistedVersion)
{
    QStringList removed;
    for (const QJsonValue &value : settings->value(QStringLiteral("removedBuiltInExtensions")).toArray()) {
        if (value.isString()) removed.append(value.toString());
    }
    QStringList normalized;
    bool renamed = false;
    for (const QString &name : removed) {
        const QString mapped = builtInAliases().value(name, name);
        if (mapped != name) renamed = true;
        normalized.append(mapped);
    }
    const int version = persistedVersion.isDouble() ? persistedVersion.toInt() : 0;
    if (version == kBuiltInDefaultsVersion && !renamed) {
        settings->insert(QStringLiteral("removedBuiltInExtensions"), QJsonArray::fromStringList(normalized));
        settings->insert(QStringLiteral("builtInExtensionDefaultsVersion"), kBuiltInDefaultsVersion);
        return false;
    }
    // Version 1 disabled better-compaction, version 2 disabled websearch; later versions
    // added nothing, so an upgrade must not re-disable what the user restored.
    QStringList next = normalized;
    if (version < 1 && !next.contains(QStringLiteral("pideck-q-better-compaction.ts"))) {
        next.append(QStringLiteral("pideck-q-better-compaction.ts"));
    }
    if (version < 2 && !next.contains(QStringLiteral("pideck-q-websearch.ts"))) {
        next.append(QStringLiteral("pideck-q-websearch.ts"));
    }
    settings->insert(QStringLiteral("removedBuiltInExtensions"), QJsonArray::fromStringList(next));
    settings->insert(QStringLiteral("builtInExtensionDefaultsVersion"), kBuiltInDefaultsVersion);
    return true;
}

/** Compare UNC spellings without using the host's rules for parsing the share root. */
QString comparableUncPiPath(const QString &path)
{
    // Legacy settings can contain four literal backslashes at the start and
    // doubled separators inside the path. Treat both spellings as UNC only here.
    const qsizetype prefixLength = path.startsWith(QLatin1String("\\\\\\\\")) ? 4 : 2;
    QString relative = path.mid(prefixLength);
    relative.replace(QLatin1Char('\\'), QLatin1Char('/'));
    if (relative.startsWith(QLatin1Char('/'))) return path;
    // Keep device prefixes intact and compare only spelling: extended paths
    // may have literal dot segments, so don't normalize them as UNC shares.
    if (relative.startsWith(QLatin1String("?/")) || relative.startsWith(QLatin1String("./"))) {
        return QLatin1String("//") + relative.toLower();
    }
    const QStringList components = relative.toLower().split(QLatin1Char('/'), Qt::SkipEmptyParts);
    if (components.size() < 2) return path;
    const auto &server = components[0];
    const auto &share = components[1];
    // Keep malformed roots distinct from ordinary shares.
    if (server == QLatin1String("?") || server == QLatin1String(".") || server == QLatin1String("..")
        || share == QLatin1String(".") || share == QLatin1String("..")) return path;
    QStringList normalized{server, share};
    for (qsizetype i = 2; i < components.size(); ++i) {
        const auto &part = components[i];
        if (part == QLatin1String(".")) continue;
        if (part == QLatin1String("..")) {
            if (normalized.size() == 2) return path;
            normalized.removeLast();
        } else {
            normalized.append(part);
        }
    }
    return QLatin1String("//") + normalized.join(QLatin1Char('/'));
}

/** Normalize stored command paths without requiring an old installation to still exist. */
QString comparablePiPath(QString path)
{
    path = path.trimmed();
    // Match the locator's accepted pasted quotes using only strings. Migration must
    // also recognize removed executables without probing for a platform-specific shim.
    while (path.size() >= 2
           && ((path.front() == QLatin1Char('"') && path.back() == QLatin1Char('"'))
               || (path.front() == QLatin1Char('\'') && path.back() == QLatin1Char('\''))
               || (path.front() == QChar(0x201c) && path.back() == QChar(0x201d))
               || (path.front() == QChar(0x2018) && path.back() == QChar(0x2019)))) {
        path = path.mid(1, path.size() - 2).trimmed();
    }
    // Locator status uses a display command for WSL, whereas the custom setting uses
    // a URL. Both identify the same Linux command, whose case must remain significant.
    static const QRegularExpression wslCommand(
        QStringLiteral("^wsl\\s+-d\\s+(.+?)\\s+-u\\s+(\\S+)\\s+(.+)$"));
    const QRegularExpressionMatch wslMatch = wslCommand.match(path);
    if (wslMatch.hasMatch()) {
        return QStringLiteral("wsl://%1/%2/%3")
            .arg(wslMatch.captured(1), wslMatch.captured(2), QDir::cleanPath(wslMatch.captured(3)));
    }
    static const QRegularExpression wslUrl(QStringLiteral("^wsl://([^/]+)/([^/]+)/(.+)$"));
    const QRegularExpressionMatch urlMatch = wslUrl.match(path);
    if (urlMatch.hasMatch()) {
        return QStringLiteral("wsl://%1/%2/%3")
            .arg(urlMatch.captured(1), urlMatch.captured(2), QDir::cleanPath(urlMatch.captured(3)));
    }
    if (path.isEmpty() || path.startsWith(QLatin1String("wsl://"))) return path;
#ifdef Q_OS_WIN
    // Windows also accepts mixed leading separators. Parse their share roots
    // here instead of letting QDir::cleanPath resolve .. across the share.
    if (path.startsWith(QLatin1String("/\\")) || path.startsWith(QLatin1String("\\/"))) {
        return comparableUncPiPath(path);
    }
#else
    // More than two leading slashes on POSIX name an ordinary local path.
    if (path.startsWith(QLatin1String("///"))) return QDir::cleanPath(path);
#endif
    if (path.startsWith(QLatin1String("\\\\")) || path.startsWith(QLatin1String("//"))) {
        return comparableUncPiPath(path);
    }
    // A Windows drive path keeps its case-insensitive identity even on Linux.
    // A backslash inside a POSIX filename remains a literal character.
#ifdef Q_OS_WIN
    const bool windowsPath = true;
#else
    static const QRegularExpression windowsPrefix(QStringLiteral("^[A-Za-z]:[\\\\/]"));
    const bool windowsPath = windowsPrefix.match(path).hasMatch();
#endif
    if (windowsPath) {
        path.replace(QLatin1Char('\\'), QLatin1Char('/'));
        path = path.toLower();
    }
    return QDir::cleanPath(path);
}

/** Remove the retired implementation's settings while keeping unrelated custom commands. */
bool migrateRetiredPiRuntime(QJsonObject *settings)
{
    const QString preference = settings->value(QStringLiteral("piRuntimePreference")).toString().trimmed();
    const bool retiredPreference = preference.compare(QLatin1String("rust"), Qt::CaseInsensitive) == 0;
    const bool legacyRuntimeSettings = settings->contains(QStringLiteral("piRustPath")) || retiredPreference;
    const QString oldPath = comparablePiPath(settings->value(QStringLiteral("piRustPath")).toString());
    const QString customPath = comparablePiPath(settings->value(QStringLiteral("customPiPath")).toString());
    const QJsonObject installed = settings->value(QStringLiteral("piInstall")).toObject();
    const QString installedPath = comparablePiPath(installed.value(QStringLiteral("command")).toString());
    static const QRegularExpression retiredName(
        QStringLiteral("^(?:pi-rust|pi_agent_rust)(?:\\.(?:exe|cmd|bat|sh))?$"),
        QRegularExpression::CaseInsensitiveOption);
    static const QRegularExpression retiredVersion(
        QStringLiteral("^pi\\s+v?\\d+\\.\\d+\\.\\d+\\b"),
        QRegularExpression::CaseInsensitiveOption);
    const QString installedKind = installed.value(QStringLiteral("runtimeKind")).toString();
    static const QRegularExpression supportedVersion(QStringLiteral("^v?\\d+\\.\\d+\\.\\d+\\b"));
    const bool retiredMetadata = installedKind.compare(QLatin1String("rust"), Qt::CaseInsensitive) == 0
        || retiredVersion.match(installed.value(QStringLiteral("version")).toString().trimmed()).hasMatch();
    const bool supportedInstall = !retiredMetadata
        && (installedKind == QLatin1String("typescript") || installedKind == QLatin1String("bolt")
            || supportedVersion.match(installed.value(QStringLiteral("version")).toString().trimmed()).hasMatch());
    const bool retiredInstall = retiredMetadata || (legacyRuntimeSettings && !supportedInstall
        && retiredName.match(installedPath.section(QLatin1Char('/'), -1)).hasMatch());
    const bool supportedCustom = supportedInstall && !customPath.isEmpty() && customPath == installedPath;
    // A confirmed supported implementation can reuse an old command name. Name-only
    // cleanup is limited to old settings: after that field is removed, clearing an
    // installation cache must never erase the user's already-migrated custom path.
    const bool retiredCustom = !customPath.isEmpty()
        && !supportedCustom
        && ((legacyRuntimeSettings && retiredName.match(customPath.section(QLatin1Char('/'), -1)).hasMatch())
            || (!oldPath.isEmpty() && customPath == oldPath)
            || (retiredInstall && customPath == installedPath));

    const bool nullInstall = settings->value(QStringLiteral("piInstall")).isNull();
    bool changed = settings->contains(QStringLiteral("piRustPath")) || nullInstall;
    settings->remove(QStringLiteral("piRustPath"));
    // Null is a patch deletion marker, never a value returned in an AppSettings snapshot.
    if (nullInstall) settings->remove(QStringLiteral("piInstall"));
    if (retiredPreference) {
        settings->insert(QStringLiteral("piRuntimePreference"), QStringLiteral("auto"));
        changed = true;
    }
    if (retiredCustom) {
        settings->insert(QStringLiteral("customPiPath"), QStringLiteral(""));
        changed = true;
    }
    if (retiredPreference || retiredInstall || retiredCustom) {
        settings->remove(QStringLiteral("piInstall"));
        settings->insert(QStringLiteral("piEnvironmentChecked"), false);
        changed = true;
    }
    return changed;
}

/**
 * Apply every load-time migration; returns true when the file must be rewritten.
 *
 * `parsed` is the raw on-disk object (not the merged one): only persisted fields tell an
 * old preference apart from a fresh install's default.
 */
bool applyMigrations(QJsonObject *settings, const QJsonObject &parsed)
{
    bool changed = migrateRetiredPiRuntime(settings);
    changed = settings->contains(QStringLiteral("sessionTabOpenMode")) || changed;
    settings->remove(QStringLiteral("sessionTabOpenMode"));

    // An old null or non-boolean must not make the renderer draw custom chrome
    // while the window host falls back to its system frame.
    const QString titleBarKey = QStringLiteral("useNativeTitleBar");
    if (!settings->value(titleBarKey).isBool()) {
        settings->insert(titleBarKey, true);
        changed = true;
    }

    // The built-in commit prompt follows the UI language; a custom template is kept.
    const QString persistedPrompt = parsed.value(QStringLiteral("gitCommitMessagePrompt")).toString();
    const bool customPrompt = !persistedPrompt.isEmpty()
        && persistedPrompt != defaultGitCommitMessagePromptFor(QStringLiteral("zh-CN"))
        && persistedPrompt != defaultGitCommitMessagePromptFor(QStringLiteral("en-US"));
    if (!customPrompt) {
        const QString localized = defaultGitCommitMessagePromptFor(
            resolvePromptLocale(settings->value(QStringLiteral("language")).toString()) == maincopy::Locale::EnUS
                ? QStringLiteral("en-US")
                : QStringLiteral("zh-CN"));
        if (settings->value(QStringLiteral("gitCommitMessagePrompt")).toString() != localized) {
            settings->insert(QStringLiteral("gitCommitMessagePrompt"), localized);
            changed = true;
        }
    }

    // The bundled CommitMono font was removed from the package.
    if (settings->value(QStringLiteral("fontFamilyMono")).toString() == QStringLiteral("commit-mono")) {
        settings->insert(QStringLiteral("fontFamilyMono"), QStringLiteral("system-mono"));
        changed = true;
    }

    // contentMaxWidth (px) → chatContentWidthPct (%): only for a file that predates the
    // percentage field. 1800px meant "unlimited", so it maps to 100%.
    const QJsonValue pct = parsed.value(QStringLiteral("chatContentWidthPct"));
    if (!(pct.isDouble() && std::isfinite(pct.toDouble()))
        && parsed.contains(QStringLiteral("contentMaxWidth"))) {
        const QJsonValue legacy = parsed.value(QStringLiteral("contentMaxWidth"));
        double mapped = 100;
        if (legacy.isDouble() && legacy.toDouble() > 0 && legacy.toDouble() < 1800) {
            const double px = legacy.toDouble();
            mapped = std::min(100.0, std::max(60.0, std::round(((px - 800) / 1000) * 40 + 60)));
        }
        settings->insert(QStringLiteral("chatContentWidthPct"), mapped);
        changed = true;
    }

    if (migrateBuiltInDefaults(settings, parsed.value(QStringLiteral("builtInExtensionDefaultsVersion")))) {
        changed = true;
    }

    // A missing or malformed token would let the web service start with weak auth.
    if (!isValidWebServiceAccessToken(settings->value(QStringLiteral("webServiceAccessToken")).toString())) {
        settings->insert(QStringLiteral("webServiceAccessToken"), generateAccessToken());
        changed = true;
    }
    return changed;
}

/**
 * Persist without the host-owned `showThinking` field (pi owns that value).
 *
 * Returns false with `error` when the atomic replace failed: the caller decides whether a
 * write failure is fatal. Reads stay best-effort (`readInternal`), saves never are.
 */
bool writeSettingsFile(const QString &filePath, const QJsonObject &settings, QString *error)
{
    QJsonObject persistable = settings;
    persistable.remove(QStringLiteral("showThinking"));
    persistable.remove(QStringLiteral("installationType"));
    persistable.remove(QStringLiteral("sessionTabOpenMode"));
    return jsonfile::writeJsonAtomic(filePath, persistable, error);
}

SettingsCatalogRead readInternal(const QString &filePath, const QString &agentDir, bool persist)
{
    SettingsCatalogRead result;
    QJsonValue value;
    const jsonfile::ReadState state = jsonfile::readJson(filePath, &value, nullptr);
    QJsonObject parsed;
    if (state == jsonfile::ReadState::Ok) {
        parsed = value.toObject();
    } else if (state == jsonfile::ReadState::Unreadable) {
        result.error = QStringLiteral("Unable to read settings");
        return result;
    }
    // A corrupt file falls back to defaults; the oracle then overwrites it on the next
    // save, which is what the migration write below does.
    QJsonObject settings = mergeObjects(defaultSettings(), parsed);
    const bool changed = applyMigrations(&settings, parsed);
    settings.insert(QStringLiteral("installationType"), QStringLiteral("portable"));
    // showThinking is never persisted: it mirrors pi's own hideThinkingBlock.
    const QJsonValue showThinking = readPiShowThinking(agentDir);
    settings.insert(QStringLiteral("showThinking"),
                    showThinking.isBool() ? showThinking : QJsonValue(true));
    if (persist && (changed || state == jsonfile::ReadState::Invalid)) {
        // Best effort: a read-only profile must not fail every settings read.
        writeSettingsFile(filePath, settings, nullptr);
    }
    result.ok = true;
    result.settings = settings;
    return result;
}

} // namespace

bool isValidWebServiceAccessToken(const QString &value)
{
    static const QRegularExpression pattern(QStringLiteral("^[A-Za-z0-9_-]{32,128}$"));
    return pattern.match(value).hasMatch();
}

QString defaultGitCommitMessagePromptFor(const QString &language)
{
    return maincopy::defaultGitCommitMessagePrompt(language);
}

SettingsCatalogRead readSettingsCatalog(const QString &filePath, const QString &agentDir)
{
    return readInternal(filePath, agentDir, true);
}

SettingsCatalogRead readSettingsCatalogSnapshot(const QString &filePath, const QString &agentDir)
{
    return readInternal(filePath, agentDir, false);
}

bool canPersistCustomPiInstallation(const QJsonObject &installation)
{
    const QString command = installation.value(QStringLiteral("command")).toString();
    if (command.isEmpty()) return false;
    QJsonObject candidate{
        {QStringLiteral("customPiPath"), command},
        {QStringLiteral("piInstall"), installation},
    };
    // Use exactly the same retirement policy as the eventual write, without changing
    // the user's previous command when the newly probed candidate cannot be retained.
    migrateRetiredPiRuntime(&candidate);
    return candidate.value(QStringLiteral("customPiPath")).toString() == command;
}

SettingsCatalogRead updateSettingsCatalog(const QString &filePath, const QJsonObject &patch,
                                          const QString &agentDir)
{
    SettingsCatalogRead current = readInternal(filePath, agentDir, false);
    if (!current.ok) return current;
    QJsonObject safePatch = patch;
    // Host-owned fields cannot be changed through the renderer.
    safePatch.remove(QStringLiteral("installationType"));
    safePatch.remove(QStringLiteral("showThinking"));
    for (const QString &legacy : kLegacyKeys) safePatch.remove(legacy);
    // Only a boolean can override the user's current chrome preference.
    const QString titleBarKey = QStringLiteral("useNativeTitleBar");
    if (!safePatch.value(titleBarKey).isBool()) safePatch.remove(titleBarKey);
    // A weak or empty token must not silently downgrade the web service.
    if (safePatch.contains(QStringLiteral("webServiceAccessToken"))
        && !isValidWebServiceAccessToken(
            safePatch.value(QStringLiteral("webServiceAccessToken")).toString())) {
        safePatch.remove(QStringLiteral("webServiceAccessToken"));
    }

    const bool languageChanged = safePatch.contains(QStringLiteral("language"));
    const bool promptProvided = safePatch.contains(QStringLiteral("gitCommitMessagePrompt"));
    const QString existingPrompt = current.settings.value(QStringLiteral("gitCommitMessagePrompt")).toString();
    const bool promptWasDefault = existingPrompt.trimmed().isEmpty()
        || existingPrompt == defaultGitCommitMessagePromptFor(QStringLiteral("zh-CN"))
        || existingPrompt == defaultGitCommitMessagePromptFor(QStringLiteral("en-US"));

    QJsonObject next = current.settings;
    for (auto it = safePatch.begin(); it != safePatch.end(); ++it) {
        // JSON drops undefined properties, so the renderer explicitly sends null to
        // clear this optional cache. Other settings keep their existing null semantics.
        if (it.key() == QLatin1String("piInstall") && it.value().isNull()) next.remove(it.key());
        else next.insert(it.key(), it.value());
    }
    // Old renderer snapshots must not restore removed runtime fields on the next save.
    migrateRetiredPiRuntime(&next);
    // Switching language re-localizes the built-in template but never a custom one.
    if (languageChanged && !promptProvided && promptWasDefault) {
        next.insert(QStringLiteral("gitCommitMessagePrompt"),
                    defaultGitCommitMessagePromptFor(
                        resolvePromptLocale(next.value(QStringLiteral("language")).toString())
                            == maincopy::Locale::EnUS
                            ? QStringLiteral("en-US")
                            : QStringLiteral("zh-CN")));
    }
    next.insert(QStringLiteral("installationType"), QStringLiteral("portable"));
    SettingsCatalogRead result;
    if (!writeSettingsFile(filePath, next, nullptr)) {
        // The oracle awaits `writeSettings` *before* it swaps its snapshot, so a rejected
        // write keeps both the file and the in-memory settings on the old values. Reporting
        // `ok` here would tell the renderer "saved" and then let `settings:update` apply
        // side effects (window chrome, zoom, proxy, LAN listener) for a value that never
        // reached disk. The prior file is untouched by the atomic write, so the reload below
        // would also silently return the old values under a success answer.
        result.ok = false;
        result.error = QStringLiteral("Unable to save settings");
        return result;
    }

    return readInternal(filePath, agentDir, false);
}
