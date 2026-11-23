#pragma once

#include <QJsonObject>
#include <QString>

/**
 * pi's own `settings.json` defaults (oracle `ensureAllPiSettingsDefaults`).
 *
 * Pure file surgery: no settings store, no executor, no logging — the startup task owns
 * scheduling and error reporting, so this module stays unit-testable on its own.
 */
namespace pisettingsdefaults {

/** The default block written into a fresh pi settings.json. */
QJsonObject defaults();

/**
 * Fill the missing defaults of one existing `<agentDir>/settings.json`.
 *
 * Never creates the file and never overwrites a present key: this is a repair pass, not
 * a migration. Written atomically (`writeFileAtomic` in the oracle) because a crash
 * between truncate and write leaves a half JSON that pi refuses to load.
 *
 * @param piVersion written as `lastChangelogVersion` when non-empty and absent.
 * @returns true when the file was written.
 */
bool ensureFor(const QString &agentDir, const QString &piVersion, QString *error);

} // namespace pisettingsdefaults
