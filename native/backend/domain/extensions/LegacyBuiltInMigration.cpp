#include "LegacyBuiltInMigration.h"

#include "BuiltInExtensions.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>

namespace legacymigration {
namespace {

constexpr const char *kChangePiPromptEntry = "change-pi-prompt.ts";

QString stemOf(const QString &fileName)
{
    const int dot = fileName.lastIndexOf(QLatin1Char('.'));
    return dot > 0 ? fileName.left(dot) : fileName;
}

/** Read a whole file; empty `readable == false` when it could not be opened. */
QString readAll(const QString &path, bool *readable)
{
    *readable = false;
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return QString();
    *readable = true;
    return QString::fromUtf8(file.readAll());
}

} // namespace

QVector<EntryRule> entryRules()
{
    // Only entry shapes PiDeck itself has written are listed: `self-use-shim` is the
    // forwarding entry the pre-PiDeck self-use build produced — it references the local
    // runtime implementation *and* carries our fixed header sentence, so a user-written
    // prompt extension cannot accidentally contain both.
    //
    // Deliberately *not* fingerprinted: the older stand-alone `change-pi-prompt.ts` with
    // its own full implementation (os / spawnSync platform probing). It may predate
    // PiDeck on that machine, so its origin is not PiDeck's call to make: unknown origin
    // means "left in place".
    return {EntryRule{QString::fromLatin1(kChangePiPromptEntry),
                      QStringLiteral("pideck-q-change-pi-prompt")}};
}

QString identifyEntry(const QString &fileName, const QString &content)
{
    for (const EntryRule &rule : entryRules()) {
        if (rule.fileName != fileName) continue;
        if (content.contains(QLatin1String("registerPromptExtension"))
            && content.contains(QLatin1String("./change-pi-prompt/runtime.ts"))
            && content.contains(QLatin1String("Pi prompt replacement extension"))) {
            return QStringLiteral("self-use-shim");
        }
    }
    return QString();
}

QString resolveBackupFileName(const std::function<bool(const QString &)> &used,
                              const QString &fileName, qint64 timestamp)
{
    QString candidate = fileName;
    const int dot = fileName.lastIndexOf(QLatin1Char('.'));
    const QString stem = stemOf(fileName);
    const QString extension = dot > 0 ? fileName.mid(dot) : QStringLiteral(".ts");
    int attempt = 0;
    while (used(candidate)) {
        ++attempt;
        const QString suffix =
            attempt == 1 ? QString::number(timestamp)
                         : QStringLiteral("%1-%2").arg(timestamp).arg(attempt);
        candidate = stem + QLatin1Char('.') + suffix + extension;
    }
    return candidate;
}

QStringList staleEntryNames()
{
    QStringList names = builtext::names();
    names.append(builtext::legacyNames());
    // Two PiDeck-only files that no longer ship in any form; the oracle keeps them in
    // the same cleanup list so an old install cannot keep loading them from disk.
    names.append(QStringLiteral("pi-deck-project-trust.ts"));
    names.append(QStringLiteral("pi-deck-file-capture.ts"));
    names.removeDuplicates();
    return names;
}

StaleOutcome removeStaleEntries(const QStringList &agentDirs)
{
    StaleOutcome outcome;
    const QStringList names = staleEntryNames();
    for (const QString &agentDir : agentDirs) {
        if (agentDir.isEmpty()) continue;
        const QString extensionsDir = QDir(agentDir).filePath(QStringLiteral("extensions"));
        for (const QString &name : names) {
            const QString target = QDir(extensionsDir).filePath(name);
            if (!QFileInfo::exists(target)) continue;
            if (QFile::remove(target)) outcome.removed.append(target);
            else outcome.kept.append(target);
        }
    }
    return outcome;
}

Outcome migrate(const QStringList &agentDirs, const QString &version)
{
    Outcome outcome;
    const QString backupVersion = version.isEmpty() ? QStringLiteral("unknown") : version;
    for (const QString &agentDir : agentDirs) {
        if (agentDir.isEmpty()) continue;
        const QString extensionsDir = QDir(agentDir).filePath(QStringLiteral("extensions"));
        const QString backupDir =
            QDir(agentDir).filePath(QStringLiteral("pideck-backups/") + backupVersion);
        for (const EntryRule &rule : entryRules()) {
            const QString source = QDir(extensionsDir).filePath(rule.fileName);
            const QFileInfo info(source);
            // `stat` must succeed and be a file: a directory named like the entry is not
            // ours to touch.
            if (!info.isFile()) continue;

            bool readable = false;
            const QString content = readAll(source, &readable);
            if (!readable) {
                outcome.preserved.append(Outcome::Preserved{rule.fileName, source,
                                                            QStringLiteral("unknown")});
                outcome.warnings.append(QStringLiteral("Cannot read %1; left in place.").arg(source));
                continue;
            }

            const QString fingerprint = identifyEntry(rule.fileName, content);
            if (fingerprint.isEmpty()) {
                outcome.preserved.append(Outcome::Preserved{rule.fileName, source,
                                                            QStringLiteral("unknown")});
                outcome.warnings.append(
                    QStringLiteral("%1 is not a PiDeck-authored file; kept in place. Built-in \"%2\" "
                                   "and this global copy will both load - rename or remove the file "
                                   "to use the built-in alone.")
                        .arg(source, rule.builtInId));
                continue;
            }

            if (!QDir().mkpath(backupDir)) {
                outcome.preserved.append(Outcome::Preserved{rule.fileName, source,
                                                            QStringLiteral("backup-failed")});
                outcome.warnings.append(
                    QStringLiteral("Cannot back up %1; left in place.").arg(source));
                continue;
            }
            // Conflict handling follows the disk, not a memory list: the backup directory
            // is reused across versions, and `NewOnly` closes the race where another run
            // claims the same name between the probe and the write.
            const QString backupName = resolveBackupFileName(
                [&backupDir](const QString &name) { return QFileInfo::exists(QDir(backupDir).filePath(name)); },
                rule.fileName, QDateTime::currentMSecsSinceEpoch());
            const QString backup = QDir(backupDir).filePath(backupName);
            QFile target(backup);
            bool written = target.open(QIODevice::WriteOnly | QIODevice::NewOnly);
            if (written) {
                written = target.write(content.toUtf8()) == content.toUtf8().size();
                target.close();
            }
            bool verified = false;
            if (written) {
                // "The backup exists and matches" is the precondition for deleting the
                // original; anything else keeps the user's file.
                verified = readAll(backup, &written) == content && written;
            }
            if (!verified) {
                QFile::remove(backup);
                outcome.preserved.append(Outcome::Preserved{rule.fileName, source,
                                                            QStringLiteral("backup-failed")});
                outcome.warnings.append(
                    QStringLiteral("Cannot back up %1; left in place.").arg(source));
                continue;
            }
            if (!QFile::remove(source)) {
                outcome.preserved.append(Outcome::Preserved{rule.fileName, source,
                                                            QStringLiteral("backup-failed")});
                outcome.warnings.append(
                    QStringLiteral("Cannot remove %1 after backing it up.").arg(source));
                continue;
            }
            outcome.moved.append(Outcome::Moved{rule.fileName, fingerprint, backup});
        }
    }
    return outcome;
}

} // namespace legacymigration
