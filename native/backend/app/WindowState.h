#pragma once

#include <QJsonObject>
#include <QString>

/**
 * Last normal window bounds (startupWindowMode="last" storage).
 *
 * Stored in `userData/last-window-bounds.json`, separate from settings.json
 * because it is runtime state, not user configuration. Mirrors
 * src/main/windowState.ts: a legacy size-only file is still valid, and a
 * partial/corrupt position must not move the window to a fabricated origin.
 */
namespace windowstate {

/** Returns an empty object when the file is missing, corrupt, or too small. */
QJsonObject readLastWindowBounds(const QString &userDataDir);

/** Persist rounded bounds. Failures are silent: window memory is optional. */
void saveLastWindowBounds(const QString &userDataDir, const QJsonObject &bounds);

} // namespace windowstate
