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
        {QStringLiteral("useNativeTitleBar"), false},
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
        {QStringLiteral("piRustPath"), QStringLiteral("")},
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
        {QStringLiteral("rpcTimeout"), 600000},
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

/**
 * Apply every load-time migration; returns true when the file must be rewritten.
 *
 * `parsed` is the raw on-disk object (not the merged one): only persisted fields tell an
 * old preference apart from a fresh install's default.
 */
bool applyMigrations(QJsonObject *settings, const QJsonObject &parsed)
{
    bool changed = settings->contains(QStringLiteral("sessionTabOpenMode"));
    settings->remove(QStringLiteral("sessionTabOpenMode"));

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
    for (auto it = safePatch.begin(); it != safePatch.end(); ++it) next.insert(it.key(), it.value());
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
