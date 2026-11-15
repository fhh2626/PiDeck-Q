#pragma once

#include <QByteArray>
#include <QString>

class QIODevice;

/**
 * Bounded, error-checked byte streaming for the file drawer.
 *
 * Why this exists: the copy path used `readAll()` + a single `write()`, which silently
 * ignores both halves of the failure. `QFile::write` returns a byte count (and buffers
 * internally, so ENOSPC/EIO/quota faults surface late), `QFile::close` is void, and an
 * interrupted read returns a short buffer instead of throwing. Node's `copyFile`/
 * `readFile` reject on ENOSPC/EIO, so a swallowed failure here means `files:move`
 * deletes the source after a zero-byte "successful" copy.
 *
 * Both helpers therefore stream in `kCopyBlockBytes` blocks, fail on a short write, a
 * write error, a read error or a mid-stream rejection, and never hold more than one
 * block (plus the caller's `maxBytes`) in memory — a multi-GB drag must not be read
 * into the sidecar heap.
 */
namespace fsops {

/** Block size for streamed copies/reads: bounds sidecar memory for large files. */
constexpr int kCopyBlockBytes = 1 << 20;

/**
 * Copy `source` into `destination` until EOF.
 *
 * Throws `std::runtime_error` when the read fails or ends in an error, and when a write
 * is short or fails, so a truncated destination is never reported as a copy. Neither
 * handle is closed here: the caller owns flushing, closing and the timestamp restore.
 */
void copyFileContents(QIODevice &source, QIODevice &destination, const QString &sourcePath);

/**
 * Streamed copy of one file into a destination the caller has just created exclusively,
 * finished with Node's `copyFile` failure cleanup.
 *
 * `destination` must have been opened by the caller with `QIODevice::NewOnly` at
 * `destinationPath`; that is the only case where deleting the destination on failure is
 * safe. Any failure after that create - a short write, a write error, a `flush()` error or
 * a read error - closes both handles, removes the file this call created (best-effort) and
 * rethrows the original error.
 *
 * Why: `fs.copyFile` attempts `rm(dest)` when the copy fails after it created the
 * destination, so a failed copy never leaves a truncated file behind. The stakes are
 * higher here because `files:move` deletes the source right after a successful copy, so a
 * half-written destination that is reported as a copy is silent user data loss.
 *
 * A pre-existing target never reaches this function (the exclusive open refuses it), so
 * this can never delete a file the caller did not create.
 */
void copyNewFileContentsWithCleanup(QIODevice &source, QIODevice &destination,
                                    const QString &destinationPath, const QString &sourcePath);

/**
 * Read `device` to EOF, at most `maxBytes` (0 = unbounded) with the same error rules.
 *
 * A read that ends in an error throws instead of returning a truncated buffer (the
 * oracle's `readFile` rejects on EIO). When the size limit is exceeded the oversized
 * prefix is returned so the caller can report `FILE_TOO_LARGE` with the real size.
 */
QByteArray readAllChecked(QIODevice &device, const QString &path, qint64 maxBytes);

} // namespace fsops
