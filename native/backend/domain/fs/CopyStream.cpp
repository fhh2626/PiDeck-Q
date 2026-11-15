#include "CopyStream.h"

#include "../../process/TextEncoding.h"

#include <QFile>
#include <QFileDevice>
#include <QIODevice>

#include <stdexcept>

namespace fsops {
namespace {

std::runtime_error failure(const QString &message)
{
    // `textenc::error` keeps std::string off the Qt ABI boundary, like every other
    // filesystem failure in this domain.
    return textenc::error(message);
}

/**
 * Did the handle record a device-level error?
 *
 * `QFile` buffers its writes, so a full volume can be reported by `error()` (or by the
 * final `flush()`) instead of by the byte count. Only QFileDevice exposes the enum; a
 * generic QIODevice reports failures through the `read`/`write` return value alone.
 */
bool deviceFailed(QIODevice &device)
{
    auto *fileDevice = dynamic_cast<QFileDevice *>(&device);
    return fileDevice && fileDevice->error() != QFileDevice::NoError;
}

} // namespace

void copyFileContents(QIODevice &source, QIODevice &destination, const QString &sourcePath)
{
    QByteArray block(kCopyBlockBytes, Qt::Uninitialized);
    for (;;) {
        const qint64 read = source.read(block.data(), block.size());
        // `read` returns -1 for an I/O error and 0 for EOF: a short read is not a
        // truncated file, it is only a smaller block than requested.
        if (read < 0) throw failure(QStringLiteral("Unable to read %1").arg(sourcePath));
        if (read == 0) {
            if (deviceFailed(source)) throw failure(QStringLiteral("Unable to read %1").arg(sourcePath));
            return;
        }
        qint64 written = 0;
        while (written < read) {
            const qint64 count = destination.write(block.constData() + written, read - written);
            // A short write is a full volume/quota: keep writing the rest of the block
            // only while the device keeps accepting bytes, and fail on no progress or an
            // error so `files:move` never deletes a source behind a truncated copy.
            if (count <= 0 || deviceFailed(destination)) {
                throw failure(QStringLiteral("Unable to copy %1").arg(sourcePath));
            }
            written += count;
        }
    }
}

/**
 * Flush the destination and report whether the device accepted everything.
 *
 * `QFile` buffers writes, so the last block's ENOSPC/EIO often surfaces only on
 * `flush()`, and `close()` is void: both have to be checked explicitly. A generic
 * QIODevice has no flush(); the write loop already rejected its failed writes.
 */
bool flushSucceeded(QIODevice &destination)
{
    auto *fileDevice = dynamic_cast<QFileDevice *>(&destination);
    if (!fileDevice) return true;
    const bool flushed = fileDevice->flush();
    return flushed && fileDevice->error() == QFileDevice::NoError;
}

void copyNewFileContentsWithCleanup(QIODevice &source, QIODevice &destination,
                                    const QString &destinationPath, const QString &sourcePath)
{
    try {
        copyFileContents(source, destination, sourcePath);
        // `QFile` buffers writes, so the last block's ENOSPC/EIO only surfaces on `flush()`.
        if (!flushSucceeded(destination)) throw failure(QStringLiteral("Unable to copy %1").arg(sourcePath));
    } catch (...) {
        // Node's `copyFile` removes the destination it created when the copy fails; the
        // caller has already proven it owns the entry (exclusive create), so this can never
        // delete a pre-existing target. Cleanup is best-effort and the original error is
        // what the user sees.
        destination.close();
        source.close();
        QFile::remove(destinationPath);
        throw;
    }
    destination.close();
    source.close();
}

QByteArray readAllChecked(QIODevice &device, const QString &path, qint64 maxBytes)
{
    QByteArray bytes;
    QByteArray block(kCopyBlockBytes, Qt::Uninitialized);
    for (;;) {
        const qint64 read = device.read(block.data(), block.size());
        // The oracle's `readFile` rejects on EIO; returning the prefix instead would show
        // the user half a file as if it were the whole file.
        if (read < 0) throw failure(QStringLiteral("Unable to read %1").arg(path));
        if (read == 0) {
            if (deviceFailed(device)) throw failure(QStringLiteral("Unable to read %1").arg(path));
            return bytes;
        }
        bytes.append(block.constData(), int(read));
        // The caller reports `FILE_TOO_LARGE` from the returned size; stopping one block
        // past the limit keeps this buffer bounded for a multi-GB file.
        if (maxBytes > 0 && bytes.size() > maxBytes) return bytes;
    }
}

} // namespace fsops
