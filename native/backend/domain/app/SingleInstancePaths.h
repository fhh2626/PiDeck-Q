#pragma once

#include <QString>

/**
 * Path and endpoint names for the version-isolated instance.
 *
 * Kept apart from the OS claim and the pipe protocol so all three use one derivation:
 * a wrong digest would silently give two versions the same endpoint.
 */
namespace singleinstance {

/** `<userData>/instance-locks` (created on demand). */
QString locksDirectory(const QString &userDataDir);
/** `<locks>/<sanitized version>.lock` — metadata only. */
QString lockPathFor(const QString &userDataDir, const QString &version);
/** `<locks>/<sanitized version>.claim` — the POSIX `flock` target. */
QString claimPathFor(const QString &userDataDir, const QString &version);
/**
 * `\\.\pipe\pideck-<sha256(userData\0version)[0:32]>` on Windows and
 * `<locks>/pideck-<digest>.sock` on POSIX. The digest keeps two versions (or two user
 * data directories) from sharing an endpoint.
 */
QString endpointFor(const QString &userDataDir, const QString &version);
/** The digest shared by the endpoint name and the OS claim. */
QString endpointDigest(const QString &userDataDir, const QString &version);
/** `[A-Za-z0-9._-]` only, matching the oracle's `sanitizeVersion`. */
QString sanitizeVersion(const QString &version);
/**
 * The name handed to QLocalServer/QLocalSocket: Windows takes the bare pipe name, POSIX
 * takes the socket path.
 */
QString endpointName(const QString &endpoint);

} // namespace singleinstance
