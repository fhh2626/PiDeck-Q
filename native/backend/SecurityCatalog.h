#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

/**
 * The security configuration owner.
 *
 * Port of src/main/security/{SecurityStore,policy}.ts. Two artefacts must stay in sync:
 *  - the configuration itself, persisted in `settings.json` under `securityConfig`;
 *  - the read-only policy snapshot (`<userData>/security-policy.json`) that the
 *    `pi-deck-security-gate` extension reads through `PIDECK_SECURITY_CONFIG`.
 *
 * The snapshot is what actually blocks a tool call, so a write failure is reported as a
 * structured error instead of being swallowed: the extension would otherwise keep
 * enforcing the previous policy while the UI shows the new one.
 */
namespace security {

/** Result of an update; `code` is one of VALIDATION_FAILED / SNAPSHOT_WRITE_FAILED / UNKNOWN_ERROR. */
struct UpdateResult {
    bool ok = false;
    QJsonObject config;
    QString error;
    QString code;
};

/** Default configuration (enabled=false keeps the gate fully permissive). */
QJsonObject defaultConfig();

/** Backward-compatible normalization: built-in levels survive, unknown default falls back. */
QJsonObject normalizeConfig(const QJsonObject &raw);

/** Validation errors; an empty list means the configuration is usable. */
QStringList validateConfig(const QJsonObject &config);

/** The snapshot payload written for the extension. */
QJsonObject buildSnapshot(const QJsonObject &config);

/** Effective level id for a session (override first, then the global default). */
QString resolveLevelId(const QJsonObject &config, const QString &sessionId);

/** Read the configuration out of `settings.json`. */
QJsonObject readConfig(const QString &settingsPath);

/**
 * Validate, persist and re-publish the snapshot.
 *
 * `patch` must already be sanitized by the channel layer (whitelist keys only).
 */
UpdateResult updateConfig(const QString &settingsPath, const QString &snapshotPath,
                          const QString &agentDir, const QJsonObject &patch);

/** Set or clear (empty levelId) one session override. */
UpdateResult setSessionLevel(const QString &settingsPath, const QString &snapshotPath,
                             const QString &agentDir, const QString &sessionId,
                             const QString &levelId);

/** Rewrite the snapshot from the current configuration (called before an agent starts). */
bool ensureSnapshot(const QString &settingsPath, const QString &snapshotPath, QString *error);

} // namespace security
