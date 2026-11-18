#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

/**
 * Vision bridge configuration and diagnostics.
 *
 * Port of src/main/settings/visionBridgeConfig.ts. The configuration file
 * (`~/.pi/agent/pi-deck-vision.json`) is shared with the `pi-deck-vision` extension, so
 * PiDeck only edits it: the extension consumes it at runtime, and a user can edit the
 * same file by hand.
 *
 * The file may contain an API key. It is written but never logged, and the run log /
 * event readers only ever return the extension's own redacted records.
 */
namespace vision {

/** `PIDECK_VISION_CONFIG_DIR` override, else `<agentDir>`. */
QString configDir(const QString &agentDir);

/** `{config, configDir}`; `config` is null when the file is missing or invalid. */
QJsonObject state(const QString &agentDir);

/** Validate an image dispatch against the current bridge choice and pi's model input capabilities. */
bool requiresModelSelection(const QString &agentDir, const QJsonObject &currentModel);

/** Whitelist-validated save. Returns `{ok}` or `{ok:false, error}`. */
QJsonObject saveConfig(const QString &agentDir, const QJsonValue &input,
                       const QString &modelsConfigDir);

/** Tail of the extension run log (`{exists, size, content, truncated}`). */
QJsonObject log(const QString &agentDir);

/** Tail of the structured conversion events (`{exists, size, events, truncated}`). */
QJsonObject events(const QString &agentDir, int limit = 200);

/** Delete the run log / event file (the extension recreates them on the next run). */
QJsonObject clearLog(const QString &agentDir);
QJsonObject clearEvents(const QString &agentDir);

/** Default prompt template, identical to the extension's DEFAULT_PROMPT. */
QString defaultPrompt();

} // namespace vision
