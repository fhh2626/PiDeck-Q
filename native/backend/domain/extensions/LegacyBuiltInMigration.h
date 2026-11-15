#pragma once

#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVector>

#include <functional>

/**
 * Legacy built-in extension migration (port of src/main/extensions/legacyBuiltInMigration.ts).
 *
 * Background: before an extension became a PiDeck built-in resource it was written to
 * `<agentDir>/extensions/<name>.ts`. pi auto-discovers that directory, so with the built-in
 * also injected through `-e` the same extension loads twice (duplicate system-prompt hooks
 * and commands). Startup therefore has to deal with the old file.
 *
 * Hard constraint: **a same-named file is not necessarily PiDeck's**. A user may have
 * copied an extension to another machine to keep editing it, or simply used the same
 * name. Every `.ts` in that directory is loaded by pi, so deleting or moving someone
 * else's file destroys user source. The migration is therefore allow-list based:
 *  - file missing / unreadable  → no-op (never delete what cannot be read)
 *  - content matches a PiDeck fingerprint → copy to `<agentDir>/pideck-backups/<version>/`,
 *    verify by reading it back, then remove the original
 *  - content does not match (unknown origin) → keep it and warn
 *  - backup name already taken → append a timestamp suffix, never overwrite
 *  - backup cannot be written / verify differs → keep the original
 *
 * The backup directory deliberately lives *outside* `extensions/`: pi only discovers
 * `extensions/*.ts` and `extensions/<dir>/index.ts`, so a sibling directory is not
 * loaded back.
 */
namespace legacymigration {

struct EntryRule {
    /** Legacy global extension file name (with extension). */
    QString fileName;
    /** Built-in id, used only for the warning copy. */
    QString builtInId;
};

/** Rules in declaration order (`LEGACY_BUILT_IN_ENTRY_RULES`). */
QVector<EntryRule> entryRules();

/**
 * Positive identification: returns the matched fingerprint label, or an empty string.
 * Pure so both the migration and its test can pin the true/false cases.
 */
QString identifyEntry(const QString &fileName, const QString &content);

/**
 * Backup target name: `<stem>.<timestamp>.<ext>` when the plain name is taken.
 * The backup directory is reused across versions and runs, and a same-named file holds
 * a different generation of the content, so overwriting loses history.
 */
QString resolveBackupFileName(const std::function<bool(const QString &)> &used,
                              const QString &fileName, qint64 timestamp);

struct Outcome {
    struct Moved {
        QString fileName;
        QString fingerprint;
        QString backup;
    };
    struct Preserved {
        QString fileName;
        QString path;
        /** "unknown" | "backup-failed" */
        QString reason;
    };
    QVector<Moved> moved;
    QVector<Preserved> preserved;
    /** User-visible problems (why a file was kept). */
    QStringList warnings;
};

/**
 * File names that are unambiguously PiDeck's own (`builtInExtensions.ts`): the shipped
 * built-ins, the renamed/retired entry points and two long-gone PiDeck files.
 *
 * Only *these* names may be deleted without reading: the name itself is proof of
 * origin because PiDeck chose it. A same-named user file (`change-pi-prompt.ts`) is not
 * in this list and goes through `migrate()`.
 */
QStringList staleEntryNames();

struct StaleOutcome {
    QStringList removed;
    /** Present but not removable (locked, read-only share); logged, never thrown. */
    QStringList kept;
};

/** Remove PiDeck-owned extension copies from `<agentDir>/extensions`. */
StaleOutcome removeStaleEntries(const QStringList &agentDirs);

/**
 * Migrate one agent directory. Never throws: every failure is a warning.
 *
 * `agentDirs` is resolved by the caller (local + the enabled WSL agent directory); each
 * directory is handled independently so one unreadable UNC share cannot stop the other.
 */
Outcome migrate(const QStringList &agentDirs, const QString &version);

} // namespace legacymigration
