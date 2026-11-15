// Deterministic regression for the file-drawer copy/read error handling.
//
// Why this is a native test and not an end-to-end one: the missing behaviour is an I/O
// fault (ENOSPC/quota/EIO/short write). Reproducing one through the public backend needs
// a size-limited volume or a device that fails mid-write, neither of which exists on a
// normal developer machine — a "copy succeeds with 0 bytes" test would pass on a healthy
// disk no matter what the code does. `fsops::copyFileContents`/`readAllChecked` are the
// production seam FileOperations uses, so the fault is injected at the device: a
// QIODevice that stops accepting bytes (or reports an error) stands in for the full
// volume. `tests/native2CopyStreamWrite.test.mjs` runs this exe and asserts the output,
// and `tests/native2FileParity.test.mjs` covers the same seam end to end for a
// multi-block file.
//
// Exit code 0 and one `ok - <case>` line per case; any failure prints `not ok - ...` and
// exits 1.
#include "CopyStream.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QIODevice>
#include <QString>
#include <QTemporaryDir>

#include <cstdio>
#include <cstring>
#include <functional>

namespace {

int g_failures = 0;

void check(bool condition, const char *name, const char *detail)
{
    if (condition) {
        std::printf("ok - %s\n", name);
    } else {
        std::printf("not ok - %s (%s)\n", name, detail);
        ++g_failures;
    }
}

/** Runs `body` and reports whether it threw a `std::exception`. */
bool throws(std::function<void()> body)
{
    try {
        body();
    } catch (const std::exception &) {
        return true;
    }
    return false;
}

/** Source device that yields `payload` and then either EOF or a simulated I/O error. */
class MemorySource : public QIODevice
{
public:
    /** `failAfterBytes < 0` = clean EOF at the end of the payload. */
    explicit MemorySource(QByteArray payload, qint64 failAfterBytes = -1)
        : m_payload(std::move(payload))
        , m_failAfter(failAfterBytes)
    {
    }

    bool isSequential() const override { return true; }

protected:
    qint64 readData(char *data, qint64 maxSize) override
    {
        if (m_failAfter >= 0 && m_offset >= m_failAfter) return -1;
        const qint64 available = qint64(m_payload.size()) - m_offset;
        if (available <= 0) return 0;
        qint64 count = qMin(available, maxSize);
        if (m_failAfter >= 0) count = qMin(count, m_failAfter - m_offset);
        memcpy(data, m_payload.constData() + m_offset, size_t(count));
        m_offset += count;
        return count;
    }

    qint64 writeData(const char *, qint64) override { return -1; }

private:
    QByteArray m_payload;
    qint64 m_failAfter = -1;
    qint64 m_offset = 0;
};

/** Sink device that records bytes until `acceptBytes` (then a short write) or errors. */
class MemorySink : public QIODevice
{
public:
    /** `acceptBytes < 0` = accept everything; `hardError` = fail every write. */
    explicit MemorySink(qint64 acceptBytes = -1, bool hardError = false)
        : m_acceptBytes(acceptBytes)
        , m_hardError(hardError)
    {
    }

    QByteArray content;

    bool isSequential() const override { return true; }

protected:
    qint64 readData(char *, qint64) override { return -1; }

    qint64 writeData(const char *data, qint64 maxSize) override
    {
        if (m_hardError) return -1;
        qint64 allowed = maxSize;
        if (m_acceptBytes >= 0) {
            const qint64 remaining = m_acceptBytes - qint64(content.size());
            // No progress at all: exactly what a full volume reports for a further block.
            if (remaining <= 0) return 0;
            allowed = qMin(allowed, remaining);
        }
        content.append(data, int(allowed));
        return allowed;
    }

private:
    qint64 m_acceptBytes = -1;
    bool m_hardError = false;
};

/** Payload that spans several copy blocks plus a partial tail block. */
QByteArray multiBlockPayload(){
    QByteArray payload;
    payload.reserve(fsops::kCopyBlockBytes * 2 + 7);
    for (int index = 0; index < fsops::kCopyBlockBytes * 2 + 7; ++index) {
        payload.append(char('a' + (index % 26)));
    }
    return payload;
}

void copyInto(MemorySource &source, MemorySink &sink)
{
    fsops::copyFileContents(source, sink, QStringLiteral("source.bin"));
}

/**
 * Real destination file that stops accepting bytes after `acceptBytes`.
 *
 * This is the deterministic stand-in for ENOSPC/quota: the file really exists on disk (so
 * the cleanup has something real to remove), but `writeData` reports short writes so the
 * production copy path treats it exactly like a full volume.
 */
class FaultingDestinationFile : public QFile
{
public:
    FaultingDestinationFile(const QString &path, qint64 acceptBytes)
        : QFile(path)
        , m_acceptBytes(acceptBytes)
    {
    }

protected:
    qint64 writeData(const char *data, qint64 maxSize) override
    {
        const qint64 accepted = qMin(maxSize, m_acceptBytes);
        // Zero progress is what a full volume reports for a further block.
        if (accepted <= 0) return 0;
        m_acceptBytes -= accepted;
        return QFile::writeData(data, accepted);
    }

private:
    qint64 m_acceptBytes = 0;
};

/** Production cleanup wrapper, called exactly like `copyWithoutOverwrite` calls it. */
void copyWithCleanup(QIODevice &source, QIODevice &destination, const QString &destinationPath)
{
    fsops::copyNewFileContentsWithCleanup(source, destination, destinationPath,
                                          QStringLiteral("source.bin"));
}

/** Write `payload` to `path` and return the size the file ended up with. */
qint64 writePayloadFile(const QString &path, const QByteArray &payload)
{
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) return -1;
    const qint64 written = file.write(payload);
    file.close();
    return written;
}

} // namespace

int main()
{
    // 1. The happy path still copies every byte across block boundaries: the block loop
    //    must not lose the partial tail block.
    {
        const QByteArray payload = multiBlockPayload();
        MemorySource source(payload);
        MemorySink sink;
        source.open(QIODevice::ReadOnly);
        sink.open(QIODevice::WriteOnly);
        copyInto(source, sink);
        check(sink.content.size() == payload.size(),
              "a multi-block copy writes every byte",
              qPrintable(QStringLiteral("wrote %1 of %2").arg(sink.content.size()).arg(payload.size())));
        check(sink.content == payload, "the copied bytes match the source", "content differs");
    }

    // 2. A short write (volume full / quota exceeded) must fail the copy. Before the
    //    bounded copy this returned success with a truncated destination, which is what
    //    let `files:move` delete the source afterwards.
    {
        const QByteArray payload = multiBlockPayload();
        MemorySource source(payload);
        MemorySink sink(fsops::kCopyBlockBytes + 11);
        source.open(QIODevice::ReadOnly);
        sink.open(QIODevice::WriteOnly);
        check(throws([&]() { copyInto(source, sink); }), "a short write fails the copy",
              "the truncated destination was reported as success");
        check(sink.content.size() == fsops::kCopyBlockBytes + 11,
              "the short write stopped at the accepted byte count", "unexpected sink size");
    }

    // 3. A write error (EIO) must fail the copy instead of being swallowed.
    {
        const QByteArray payload = multiBlockPayload();
        MemorySource source(payload);
        MemorySink sink(-1, true);
        source.open(QIODevice::ReadOnly);
        sink.open(QIODevice::WriteOnly);
        check(throws([&]() { copyInto(source, sink); }), "a write error fails the copy", "error swallowed");
    }

    // 4. A read error mid-stream must fail the copy: a truncated read is not EOF.
    {
        const QByteArray payload = multiBlockPayload();
        MemorySource source(payload, fsops::kCopyBlockBytes / 2);
        MemorySink sink;
        source.open(QIODevice::ReadOnly);
        sink.open(QIODevice::WriteOnly);
        check(throws([&]() { copyInto(source, sink); }), "a read error fails the copy",
              "the short read was treated as EOF");
    }

    // 5. `readAllChecked` rejects an interrupted read instead of returning a truncated
    //    body (`files:read-content` must not show half a file as the whole file).
    {
        MemorySource source(QByteArray("payload"), 3);
        source.open(QIODevice::ReadOnly);
        check(throws([&]() { fsops::readAllChecked(source, QStringLiteral("a.txt"), 0); }),
              "an interrupted read is an error, not a short body", "truncated body returned");
    }

    // 6. A clean read still returns the whole body.
    {
        MemorySource source(QByteArray("payload"));
        source.open(QIODevice::ReadOnly);
        const QByteArray bytes = fsops::readAllChecked(source, QStringLiteral("a.txt"), 0);
        check(bytes == QByteArray("payload"), "a complete read returns the whole body", bytes.constData());
    }

    // 7. The size limit is enforced while reading, so a huge file is never fully buffered.
    {
        const QByteArray payload = multiBlockPayload();
        MemorySource source(payload);
        source.open(QIODevice::ReadOnly);
        const qint64 limit = 4096;
        const QByteArray bytes = fsops::readAllChecked(source, QStringLiteral("big.bin"), limit);
        check(bytes.size() > limit, "an oversized read reports more bytes than the limit", "limit not exceeded");
        check(bytes.size() <= limit + fsops::kCopyBlockBytes,
              "an oversized read stops after the first block past the limit",
              qPrintable(QStringLiteral("buffered %1 bytes").arg(bytes.size())));
    }

    // 8. A streamed copy that fails after the exclusive create must delete the truncated
    //    destination it created. The oracle's `copyFile` does the same (`fs.copyFile`
    //    rejects *and* removes a partially written destination), and `files:move` deletes
    //    the source right after a "successful" copy, so leaving the stump behind is user
    //    data loss. Real temp file + a device fault: no full disk required.
    {
        const QByteArray payload = multiBlockPayload();
        QTemporaryDir dir;
        const QString sourcePath = dir.filePath(QStringLiteral("source.bin"));
        const QString destinationPath = dir.filePath(QStringLiteral("copy.bin"));
        check(writePayloadFile(sourcePath, payload) == payload.size(),
              "the fault fixture writes its source file", "source fixture write failed");
        QFile sourceFile(sourcePath);
        check(sourceFile.open(QIODevice::ReadOnly), "the fault fixture opens its source file",
              "source open failed");
        FaultingDestinationFile destination(destinationPath, fsops::kCopyBlockBytes + 11);
        check(destination.open(QIODevice::WriteOnly | QIODevice::NewOnly),
              "the fault fixture creates its destination exclusively", "NewOnly open failed");
        check(throws([&]() { copyWithCleanup(sourceFile, destination, destinationPath); }),
              "a failing streamed copy reports the failure", "the truncated copy was reported as success");
        check(!QFile::exists(destinationPath),
              "a failed copy removes the truncated destination it created",
              "the half-written destination survived, so files:move would delete the source behind it");
        check(QFileInfo(sourcePath).size() == payload.size(),
              "a failed copy leaves the source untouched", "the source file changed");
    }

    // 9. Same cleanup on a mid-stream read error: the destination was already created, so
    //    the fragment must not survive a rejected copy either.
    {
        QTemporaryDir dir;
        const QString destinationPath = dir.filePath(QStringLiteral("copy-read-error.bin"));
        MemorySource source(multiBlockPayload(), fsops::kCopyBlockBytes / 2);
        source.open(QIODevice::ReadOnly);
        QFile destination(destinationPath);
        check(destination.open(QIODevice::WriteOnly | QIODevice::NewOnly),
              "the read-fault fixture creates its destination exclusively", "NewOnly open failed");
        check(throws([&]() { copyWithCleanup(source, destination, destinationPath); }),
              "a failing read rejects the copy", "the short read was reported as success");
        check(!QFile::exists(destinationPath),
              "a rejected copy removes its partial destination", "a partial destination survived");
    }

    // 10. The cleanup must never delete a target this call did not create: the exclusive
    //     create is what proves ownership, so a pre-existing file makes the copy fail
    //     *before* the cleanup path exists and its content stays intact.
    {
        QTemporaryDir dir;
        const QString existingPath = dir.filePath(QStringLiteral("existing.bin"));
        const QByteArray kept("pre-existing\n");
        check(writePayloadFile(existingPath, kept) == kept.size(),
              "the existing-target fixture writes its file", "fixture write failed");
        QFile destination(existingPath);
        check(!destination.open(QIODevice::WriteOnly | QIODevice::NewOnly),
              "an exclusive create refuses an existing target", "NewOnly opened an existing file");
        QFile readback(existingPath);
        check(readback.open(QIODevice::ReadOnly), "the existing target is still readable", "read open failed");
        check(readback.readAll() == kept,
              "a refused copy leaves the existing target intact", "the pre-existing file was modified");
    }

    if (g_failures != 0) {
        std::printf("%d failure(s)\n", g_failures);
        return 1;
    }
    std::printf("all copy-stream cases passed\n");
    return 0;
}
