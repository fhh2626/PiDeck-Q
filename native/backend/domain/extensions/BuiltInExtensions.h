#pragma once

#include <QString>
#include <QStringList>

/**
 * PiDeck's built-in extensions.
 *
 * Port of src/main/extensions/builtInExtensions.ts. The files ship inside
 * `resources/extensions/` and are injected into pi with `--extension`; they are never
 * copied into `~/.pi/agent/extensions`, so "removing" one only records its name in
 * `settings.removedBuiltInExtensions` and cleaning a stale user copy is best effort.
 *
 * The names are also the security boundary for `extensions:remove-built-in` /
 * `restore-built-in`: only a shipped basename is accepted, so a renderer-supplied path
 * can never be turned into a file operation.
 */
namespace builtext {

/** Shipped extension file names, in the order pi receives them. */
QStringList names();

/** True when `source` is exactly one of the shipped basenames. */
bool isBuiltInName(const QString &source);

/** Old file names mapped to their current name (a rename must keep the user's choice). */
QHash<QString, QString> aliases();

/** Retired entry points that must be cleaned from pi's auto-discovery directory. */
QStringList legacyNames();

/** Built-in extension names that participate in third-party conflict detection. */
QStringList conflictKeywords();

/**
 * `extensionNameMatches`: strip the protocol prefix, a `.ts` suffix and the npm scope,
 * then test whether the package name contains the keyword.
 */
bool extensionNameMatches(const QString &source, const QString &keyword);

/** Third-party source that conflicts with `builtInName`, or an empty string. */
QString findConflict(const QStringList &thirdPartySources, const QString &builtInName);

} // namespace builtext
