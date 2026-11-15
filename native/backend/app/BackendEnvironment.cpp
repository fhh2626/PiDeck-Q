#include "BackendEnvironment.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonValue>

namespace {

QString envOr(const char *name, const QString &fallback)
{
    const QString value = qEnvironmentVariable(name).trimmed();
    return value.isEmpty() ? fallback : value;
}

QString piAgentDirectory()
{
    // The host injects PIDECK_HOME so a WSL/roaming profile resolves the same way
    // as the Node sidecar. Fall back to the OS home for direct test launches.
    const QString home = envOr("PIDECK_HOME", QDir::homePath());
    return QDir(home).filePath(QStringLiteral(".pi/agent"));
}

/**
 * The host's argv as a string list (`PIDECK_ARGV_JSON`).
 *
 * Anything that is not an array of strings yields an empty list instead of a partial
 * one: a malformed activation must degrade to "just focus the window", never to a
 * guessed session id.
 */
QStringList parsedHostArgv()
{
    const QString raw = qEnvironmentVariable("PIDECK_ARGV_JSON").trimmed();
    if (raw.isEmpty()) return {};
    const QJsonDocument document = QJsonDocument::fromJson(raw.toUtf8());
    if (!document.isArray()) return {};
    QStringList arguments;
    for (const QJsonValue &value : document.array()) {
        if (value.isString()) arguments.append(value.toString());
    }
    return arguments;
}

} // namespace

bool BackendEnvironment::parse(BackendEnvironment *out, QString *error)
{
    BackendEnvironment result;
    const QString portText = envOr("PIDECK_HOST_PORT", QString());
    bool portOk = false;
    const uint port = portText.toUInt(&portOk);
    if (!portOk || port == 0 || port > 65535) {
        if (error) *error = QStringLiteral("PIDECK_HOST_PORT is missing or invalid");
        return false;
    }
    result.hostPort = quint16(port);
    result.hostToken = qEnvironmentVariable("PIDECK_HOST_TOKEN").trimmed();
    if (result.hostToken.isEmpty()) {
        if (error) *error = QStringLiteral("PIDECK_HOST_TOKEN is missing");
        return false;
    }
    result.userDataDir = envOr("PIDECK_USER_DATA", QString());
    if (result.userDataDir.isEmpty()) {
        if (error) *error = QStringLiteral("PIDECK_USER_DATA is missing");
        return false;
    }
    QDir().mkpath(result.userDataDir);

    result.appDir = envOr("PIDECK_APP_PATH", QCoreApplication::applicationDirPath());
    result.rendererRoot = envOr("PIDECK_RENDERER_ROOT",
                                QDir(result.appDir).filePath(QStringLiteral("app/renderer")));
    // Dev-only renderer proxy target (Vite). Not a packaged setting: it exists so
    // `vite dev` can serve the LAN page, HMR included, while the bundle is unbuilt.
    // Validation (http-only, loopback-only) belongs to the web service, which logs a bad
    // value and keeps serving the bundle instead of failing the backend.
    result.devRendererUrl = envOr("PIDECK_DEV_RENDERER_URL", QString());
    result.resourcesDir = envOr("PIDECK_RESOURCES_PATH",
                                QDir(result.appDir).filePath(QStringLiteral("resources")));
    result.version = envOr("PIDECK_VERSION", QStringLiteral("0.0.0-dev"));
    result.hostArgv = parsedHostArgv();
    result.memoryProfile = envOr("PIDECK_MEMORY_PROFILE", QStringLiteral("0")) == QStringLiteral("1");
    // Sampling interval is configuration, not a domain decision: a bad value falls back to
    // the oracle's 5 s instead of disabling the profiler.
    const QString intervalText = envOr("PIDECK_MEMORY_PROFILE_INTERVAL_MS", QString());
    bool intervalOk = false;
    const int interval = intervalText.toInt(&intervalOk);
    if (intervalOk && interval > 0) result.memoryProfileIntervalMs = interval;

    // Session/prompt/skill roots follow the pi agent layout. The explicit
    // PIDECK_*_DIR overrides exist for isolated contract tests, never for the
    // packaged host (which does not set them).
    const QString agentDir = piAgentDirectory();
    result.agentDir = agentDir;
    result.sessionsDir = envOr("PIDECK_SESSIONS_DIR", QDir(agentDir).filePath(QStringLiteral("sessions")));
    result.promptsDir = envOr("PIDECK_PROMPTS_DIR", QDir(agentDir).filePath(QStringLiteral("prompts")));
    result.skillsDir = envOr("PIDECK_SKILLS_DIR", QDir(agentDir).filePath(QStringLiteral("skills")));
    result.backgroundDir = envOr("PIDECK_BACKGROUND_DIR",
                                 QDir(result.userDataDir).filePath(QStringLiteral("backgrounds")));

    *out = result;
    return true;
}
