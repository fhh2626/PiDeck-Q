#pragma once

#include <QByteArray>
#include <QJsonValue>
#include <QString>

/**
 * Atomic JSON/text persistence shared by every settings-like store.
 *
 * Two properties matter for parity and for crash safety:
 *  - the on-disk shape must match the Node oracle byte for byte (`JSON.stringify(v,
 *    null, 2)`: two-space indent, no trailing newline), because these files are read by
 *    pi and by the extensions as well as by PiDeck;
 *  - a write must never leave a truncated file behind, so every write goes through a
 *    temp file in the same directory followed by an atomic replace.
 */
namespace jsonfile {

/** `JSON.stringify(value, null, 2)` equivalent (two-space indent, no trailing newline). */
QByteArray prettyJson(const QJsonValue &value);

/** Atomic replace of `path` with `bytes`; creates the parent directory. */
bool writeBytesAtomic(const QString &path, const QByteArray &bytes, QString *error);

/** Atomic replace of `path` with the two-space JSON form of `value`. */
bool writeJsonAtomic(const QString &path, const QJsonValue &value, QString *error);

/** Read a whole file as UTF-8. Returns false when the file is missing or unreadable. */
bool readText(const QString &path, QString *out);

/**
 * Parse a JSON file. `missing` distinguishes "no file" (a legitimate default) from
 * "unreadable/corrupt" so callers can fail closed instead of silently resetting state.
 */
enum class ReadState { Ok, Missing, Unreadable, Invalid };
ReadState readJson(const QString &path, QJsonValue *out, QString *error);

/**
 * Preserve a corrupt file next to itself before it is rebuilt.
 *
 * `path.corrupt` is used first; an occupied name switches to `path.corrupt.<uuid>` so a
 * previous forensic copy is never overwritten. Returns the backup path, or an empty
 * string when the original could not be preserved (the caller must then refuse to
 * rewrite the file).
 */
QString preserveCorrupt(const QString &path, QString *error);

} // namespace jsonfile
