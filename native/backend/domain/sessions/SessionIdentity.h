#pragma once

#include <QString>

/**
 * Session identity primitives.
 *
 * Port of src/shared/sessionIdentity.ts. Every consumer (catalog, scanner, delete
 * guard, importer) must use these helpers so that "same session file" means exactly
 * one thing across the backend: case-insensitive for native Windows paths,
 * case-sensitive for WSL Linux paths, and never a host-only path rule for WSL.
 */
namespace sessionidentity {

/** `native` / `wsl`; the catalog stores this verbatim. */
bool isValidEnvironment(const QString &environment);

/** Model configuration namespace. Unknown WSL identities only match another unknown identity. */
QString environmentScopeKey(const QString &environment, const QString &wslDistro, const QString &wslUser);

/**
 * Canonical comparison form: forward slashes, no trailing slash, lower-cased for
 * native paths only. This is the value that goes into an origin key.
 */
QString canonicalizeSessionPath(const QString &filePath, const QString &environment);

/** Absolute-path test that does not depend on the host filesystem (works for WSL). */
bool isAbsoluteSessionPath(const QString &filePath, const QString &environment);

/**
 * Stable de-duplication key for one session file.
 *
 * Format mirrors the oracle exactly: `<source>:<environmentKey>:<canonicalPath>`
 * plus `:<percentEncodedImportedSourceId>` when the record came from an importer.
 */
QString buildSessionOriginKey(const QString &source, const QString &environment, const QString &filePath,
                              const QString &wslDistro, const QString &wslUser,
                              const QString &importedSourceId);

/**
 * Resolve a possibly relative pi `sessionFile` against the project cwd.
 *
 * pi reports a relative sessionFile when `sessionDir` is configured as a relative
 * path. Storing it verbatim would create a second catalog record for the same file
 * (the scanner always reports absolute paths), so every entry point normalizes.
 */
QString toAbsoluteSessionPath(const QString &filePath, const QString &projectPath, const QString &environment);

/** Windows drive path -> WSL `/mnt/<drive>/...` base (identity only, no IO). */
QString windowsPathToWslBase(const QString &path);

/**
 * Scanner comparison form: forward slashes, no trailing slash, always lower-cased.
 * Deliberately different from canonicalizeSessionPath: the scanner uses it for
 * prefix containment, where case folding is safe on both platforms.
 */
QString normalizeScanPath(const QString &path);

/** pi encoded-cwd directory token (`--C--Users-name-project--`). */
QString safePathToken(const QString &path);

/** Decode a pi encoded-cwd directory name back to a display path. */
QString decodeSessionDir(const QString &encoded);

/** Percent-encode a value for the origin key suffix (only unreserved chars survive). */
QString encodeOriginSegment(const QString &value);

} // namespace sessionidentity
