#pragma once

#include <QString>
#include <QStringList>

/**
 * Resolved runtime configuration for the C++ backend.
 *
 * The Qt host injects the bridge port/token plus the app/resource/renderer paths.
 * Everything else is derived here so no domain module reads the environment
 * directly: one owner, one place to validate, one place to log.
 */
struct BackendEnvironment {
    quint16 hostPort = 0;
    QString hostToken;
    QString userDataDir;
    QString appDir;
    QString rendererRoot;
    /**
     * Loopback Vite dev server base URL (`PIDECK_DEV_RENDERER_URL`), empty when the built
     * renderer bundle is served.
     *
     * Port of the oracle's `deps.devRendererUrl` (Electron: `ELECTRON_RENDERER_URL`). The
     * environment is the only supported input: the packaged host never sets it, and the
     * web service validates it as loopback-only before accepting it.
     */
    QString devRendererUrl;
    QString resourcesDir;
    QString sessionsDir;
    QString promptsDir;
    QString skillsDir;
    QString backgroundDir;
    /** ~/.pi/agent; part of the desktop file authorization scope. */
    QString agentDir;
    QString version;
    /**
     * The Qt host's argv (why this process was started). A protocol activation or a
     * second launch carries `pideck://session/<uuid>` here, so the backend reads one
     * parsed copy instead of every module re-reading the environment.
     */
    QStringList hostArgv;
    bool memoryProfile = false;
    /** `PIDECK_MEMORY_PROFILE_INTERVAL_MS`; the oracle's default is 5 s. */
    int memoryProfileIntervalMs = 5'000;

    /**
     * Parse and validate the environment. Returns false with a human readable
     * reason when a required value is missing; the backend must not start then.
     */
    static bool parse(BackendEnvironment *out, QString *error);
};
