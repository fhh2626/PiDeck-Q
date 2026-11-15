#pragma once

#include "WslEnvironment.h"

#include <QJsonObject>
#include <QObject>
#include <QString>

#include <memory>

class QTimer;
struct ChannelServices;

/**
 * Backend startup tasks (port of src/main/backend/backendStartupTasks.ts).
 *
 * Everything the Node sidecar starts once, in the oracle's order, because each step
 * depends on the previous one:
 *
 *  1. publish the already loaded project snapshot with the environment filter
 *     (`projects:changed`) — never reload it here: `createBackend` loaded projects before
 *     the catalog migration, and a reload could overwrite an early edit;
 *  2. raise `rpcTimeout` to the 600 s floor on the next event-loop turn;
 *  3. first-launch external-editor detection (independent of WSL);
 *  4. resolve the WSL environment *once*, apply it to the scanner / skills / prompts /
 *     extensions / pi-config owners, then
 *  5. legacy built-in extension migration plus the pi `settings.json` defaults for every
 *     agent directory (local and WSL), and
 *  6. the pi `--version` cache warm-up so the first agent spawn does not have to probe.
 *
 * A failure in any step is logged and never stops the others: a broken WSL distro must not
 * hide every skill and prompt behind an error dialog.
 */
class BackendStartupTasks : public QObject {
public:
    struct Deps {
        ChannelServices *services = nullptr;
        /** `<userData>`: desktop `settings.json` and the project catalog live here. */
        QString userDataDir;
        /** App version, used for the versioned legacy-backup directory. */
        QString version;
        /** Local session root, restored when no WSL environment applies. */
        QString localSessionsDir;
    };

    explicit BackendStartupTasks(Deps deps, QObject *parent = nullptr);
    ~BackendStartupTasks() override;

    /** Kick off the ordered work; returns immediately (WSL resolution is asynchronous). */
    void start();

    /** Cancel pending work (timers). Idempotent; called during shutdown. */
    void stop();

private:
    void logInfo(const QString &scope, const QString &message, const QJsonObject &detail = {});
    void logWarn(const QString &scope, const QString &message, const QJsonObject &detail = {});
    QJsonObject readSettings() const;

    /** Step 1: the startup `projects:changed` frame with the visibility filter. */
    void publishStartupProjects();
    /** Step 2: `rpcTimeout` floor of 600 s. */
    void applyRpcTimeoutFloor();
    /** Step 3: detect editors only when the user has none configured. */
    void detectExternalEditors();
    /** Merge one detection result into settings (main thread). */
    void applyDetectedEditors(const QJsonArray &detected);
    /** Step 5: stale/legacy built-in extension cleanup for every agent directory. */
    void runLegacyMigration();
    /** Step 5b: pi `settings.json` defaults (`lastChangelogVersion` from the probe). */
    void ensurePiSettingsDefaults(const QString &piVersion);
    /** Step 6: warm the pi `--version` cache the runtime's trust-flag probe uses. */
    /**
     * Warm the session catalog of every project in the background (oracle: 3 s after
     * start, then one project every 1.5 s) and push `sessions:catalog-refreshed` per
     * project once the merge landed, so the sidebar never waits for a cold scan.
     */
    void prewarmCatalogScans();

    /** Fill pi's settings.json defaults without overwriting user values. */
    void ensurePiSettingsDefaultsNow();
    /** Local + WSL agent directories (`agentDirsOf`). */
    QStringList agentDirs() const;
    QString settingsPath() const;

    Deps m_deps;
    /** Staggered prewarm timers (cancelled by `stop()`). */
    QList<QTimer *> m_prewarmTimers;
    QTimer *m_rpcTimeoutTimer = nullptr;
    /** Detection runs on its own thread; only used to avoid a second run. */
    bool m_editorDetectionStarted = false;
    bool m_started = false;
    bool m_stopped = false;
};
