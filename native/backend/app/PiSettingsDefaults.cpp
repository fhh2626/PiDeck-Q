#include "PiSettingsDefaults.h"

#include "JsonFile.h"

#include <QDir>
#include <QFileInfo>

namespace pisettingsdefaults {

QJsonObject defaults()
{
    // Only *missing* keys are filled: a user value (even a deliberate empty object) wins.
    return QJsonObject{
        {QStringLiteral("theme"), QStringLiteral("dark")},
        {QStringLiteral("hideThinkingBlock"), false},
        {QStringLiteral("defaultProjectTrust"), QStringLiteral("ask")},
        {QStringLiteral("compaction"),
         QJsonObject{{QStringLiteral("enabled"), true},
                     {QStringLiteral("reserveTokens"), 16'384},
                     {QStringLiteral("keepRecentTokens"), 20'000}}},
        {QStringLiteral("retry"),
         QJsonObject{{QStringLiteral("enabled"), true}, {QStringLiteral("maxRetries"), 3}}},
    };
}

/**
 * Fill the missing defaults of one existing `<agentDir>/settings.json`.
 *
 * Never creates the file (see the guard below) and never overwrites a present key: this is
 * a repair pass, not a migration. Written atomically (`writeFileAtomic` in the oracle)
 * because a crash between truncate and write leaves a half JSON that pi refuses to load —
 * and pi's settings file is the user's, not ours to rebuild silently.
 *
 * @returns true when the file was written.
 */
bool ensureFor(const QString &agentDir, const QString &piVersion, QString *error)
{
    const QString filePath = QDir(agentDir).filePath(QStringLiteral("settings.json"));
    // Only repair a file pi already owns. Creating `~/.pi/agent/settings.json` behind the
    // user's back turns "settings were never written" into "PiDeck pre-seeded them", which
    // two channel contracts pin the other way (`subagents:get-settings` must start empty and
    // `config:get-settings` must report a missing file as `{}`). pi writes its own defaults
    // on first launch, so a missing file needs no help from the host.
    if (!QFileInfo::exists(filePath)) return false;
    QJsonObject current;
    QJsonValue existing;
    const jsonfile::ReadState state = jsonfile::readJson(filePath, &existing, nullptr);
    if (state == jsonfile::ReadState::Ok && existing.isObject()) current = existing.toObject();
    // Corrupt or unreadable: the oracle starts from `{}` and rewrites, which is also the
    // only way a corrupt file ever recovers.
    bool changed = false;
    if (!piVersion.isEmpty() && !current.contains(QStringLiteral("lastChangelogVersion"))) {
        current.insert(QStringLiteral("lastChangelogVersion"), piVersion);
        changed = true;
    }
    const QJsonObject block = defaults();
    for (auto iterator = block.constBegin(); iterator != block.constEnd(); ++iterator) {
        if (current.contains(iterator.key())) continue;
        current.insert(iterator.key(), iterator.value());
        changed = true;
    }
    if (!changed) return false;
    const bool written = jsonfile::writeJsonAtomic(filePath, current, error);
    return written;
}

} // namespace pisettingsdefaults
