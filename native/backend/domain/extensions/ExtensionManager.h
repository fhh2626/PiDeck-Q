#pragma once

#include "MainCopy.h"

#include "../wsl/WslEnvironment.h"

#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVector>

#include <functional>

/**
 * Installed pi extensions (`extensions:*`).
 *
 * Port of src/main/extensions/ExtensionManager.ts. pi stays the installer: every
 * mutating operation is a `pi install/remove/update` invocation, because writing pi's
 * own settings by hand drifts from what the CLI does.
 *
 * PiDeck adds three things on top of `pi list`:
 *  - local file extensions (`~/.pi/agent/extensions/*.ts` and directories with an
 *    `index.ts`) that `pi list` does not report;
 *  - the built-in catalogue, so a removed built-in can be re-enabled from the UI;
 *  - `enabled`, which merges pi's `disabledExtensions` with PiDeck's
 *    `removedBuiltInExtensions` so the renderer never has to know both formats.
 *
 * `list()` is cached and generation-fenced: an install/uninstall/toggle invalidates the
 * cache, and a list request that started before the invalidation is discarded instead of
 * writing a stale result back.
 */
namespace extensions {

struct Summary {
    QString id;
    QString source;
    /** Empty means "no local path" (a package that pi has not resolved yet). */
    QString path;
    /** "user" | "project" | "unknown" */
    QString scope;
    /**
     * Tri-state: a package reported by `pi list` carries no `builtIn` key at all, a
     * locally discovered entry always carries a boolean, and a shipped built-in is true.
     * The renderer distinguishes "not a built-in" from "unknown", so the key cannot be
     * normalised to false.
     */
    bool builtInSet = false;
    bool builtIn = false;
    bool enabled = true;
    /** pi marked the package as a filtered install (` (filtered)` suffix). */
    bool filtered = false;
    QString currentVersion;
    QString latestVersion;
    bool hasUpdate = false;
    QString updateError;
};

struct Conflict {
    QString builtIn;
    QString thirdParty;
};

struct ListResult {
    QVector<Summary> extensions;
    QString raw;
    QVector<Conflict> conflicts;
};

QJsonObject summaryToJson(const Summary &extension);
QJsonObject listToJson(const ListResult &result);

/** Result of `pi update [--extensions]`. */
struct UpdateResult {
    QString command;
    QString output;
    bool updated = true;
};

class Manager {
public:
    using SettingsProvider = std::function<QJsonObject()>;
    using SettingsPatcher = std::function<void(const QJsonObject &patch)>;

    Manager(QString agentDir, SettingsProvider settings, SettingsPatcher patch,
            maincopy::Translator translate);

    /** Drop the cache and any in-flight result (after a mutation). */
    void invalidate();

    /**
     * Switch the pi agent directory to the resolved WSL home; `nullptr` restores the
     * injected local one. The list cache is dropped because it describes the previous
     * environment's `~/.pi/agent/extensions`.
     */
    void configureWsl(const wsl::Environment *environment);

    ListResult list(bool forceRefresh);
    /** Raw stdout of `pi install <source>`. */
    QString install(const QString &source);
    /**
     * Uninstall one extension. Returns the local path the channel must move to the
     * recycle bin (empty when `pi remove` already did the work).
     */
    QString uninstall(const QString &source, const QString &scope);
    void setEnabled(const QString &source, bool enabled);
    void removeBuiltIn(const QString &source);
    void restoreBuiltIn(const QString &source);
    UpdateResult updateAll();
    UpdateResult updateOne(const QString &source);

private:
    ListResult loadList(bool includeVersionInfo);
    QVector<Summary> scanLocalExtensions() const;
    QVector<Summary> parseListOutput(const QString &raw) const;
    Summary enrichVersion(const Summary &extension) const;
    QStringList disabledExtensions() const;
    void writePiSettings(const QStringList &disabled) const;
    void clearDisabledEntry(const QString &source) const;
    /** Authorized basename inside the extensions directory for a local uninstall. */
    QString localExtensionToTrash(const QString &source) const;
    /** Hard-delete a stale copy of a *shipped* built-in; never a user asset. */
    void removeBuiltInFile(const QString &source) const;
    void disableBuiltIn(const QString &source);
    void saveRemovedBuiltIn(const QStringList &names);
    QStringList removedBuiltIn() const;
    QString extensionsDir() const;
    QString piSettingsPath() const;

    QString m_agentDir;
    /** Construction-time agent directory; `configureWsl(nullptr)` restores it. */
    QString m_localAgentDir;
    SettingsProvider m_settings;
    SettingsPatcher m_patch;
    maincopy::Translator m_translate;

    bool m_hasCache = false;
    ListResult m_cache;
    /** Bumped by every mutation so an older in-flight list cannot publish. */
    int m_generation = 0;
};

} // namespace extensions
