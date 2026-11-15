#pragma once

#include "SessionCommand.h"

#include <QHash>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QVector>

#include <functional>

/**
 * Batched WSL session reads (port of src/main/sessions/WslScanBatchReader.ts).
 *
 * A WSL session tree is read through `wsl.exe`, and one process per file (stat + cat for
 * every JSONL) made a few-hundred-session history cost a few hundred process starts. This
 * module asks the distro for many files at once:
 *
 *  - metadata: one `stat --printf '%n\0%Y\0%s\0' -- <paths…>` per 64 files, with a
 *    per-file `stat -c` fallback so one missing file cannot discard its whole batch;
 *  - bodies: one `sh -c <script> pideck-scan-read <paths…>` per 16 files. Paths are
 *    positional arguments, never interpolated into shell code; JSONL cannot contain a
 *    literal NUL, so the NUL-separated envelope is unambiguous;
 *  - a timeout keeps the complete-prefix records, and the file that was mid-cat is marked
 *    failed *and not retried*, so a stalled read cannot cost a second full timeout. The
 *    files the batch never reached are read individually with the remaining budget.
 *
 * Budgets: 64 metadata paths, 16 body paths, 12 KiB of path arguments, 64 MiB per file,
 * 4 concurrent child processes. Bodies are consumed per group (never accumulated for the
 * whole tree), so a scan holds at most a few groups of transcript text at once.
 *
 * Cancellation and the overall scan deadline are honoured before each process start; a
 * running child is bounded by the per-command timeout, which never exceeds the remaining
 * deadline budget.
 */
namespace wslscan {

/** Paths per metadata command (oracle `METADATA_FILES`). */
constexpr int kMetadataFiles = 64;
/** Paths per body command (oracle `BODY_FILES`). */
constexpr int kBodyFiles = 16;
/** Path argument budget per body command (oracle `MAX_ARGUMENT_BYTES`). */
constexpr qint64 kMaxArgumentBytes = 12 * 1024;
/** Per-file body budget (oracle `MAX_BODY_BYTES`). */
constexpr qint64 kMaxBodyBytes = 64 * 1024 * 1024;
/** Child processes in flight (oracle `mapGroups` concurrency). */
constexpr int kConcurrency = 4;

struct Version {
    qint64 mtimeMs = 0;
    qint64 size = 0;
};

enum class BodyState { NotRequested, Failed, Success };

struct Body {
    BodyState state = BodyState::NotRequested;
    QString text;
};

struct FileRead {
    bool hasVersion = false;
    Version version;
    Body body;
};

/** `wsl -d/-u` is the caller's business; `arguments` is the inner command. */
using Execute = std::function<sessioncmd::Result(const QStringList &arguments, int timeoutMs, qint64 maxOutput)>;
using NeedsBody = std::function<bool(const QString &path, const Version &version)>;
using Consume = std::function<void(const QString &path, const FileRead &read)>;

struct Options {
    /** Absolute epoch ms for the whole scan; 0 = no deadline. */
    qint64 deadlineMs = 0;
    /** Per-command body budget, also capped by the remaining deadline. */
    int bodyTimeoutMs = 10'000;
    /** Checked before every child start; a cancelled scan returns early. */
    std::function<bool()> cancelled;
};

enum class Outcome { Completed, Cancelled, Expired };

struct ParseResult {
    /** False when the envelope is not trustworthy (caller then degrades safely). */
    bool ok = false;
    QHash<QString, Body> bodies;
    /** Files the timed-out batch never started; safe to read individually. */
    QStringList pending;
};

/** The `sh -c` body reader. Date-free and constant so both ends agree byte for byte. */
QString readFilesScript();

/**
 * Split paths into batches.
 * `versions` (body phase) bounds the aggregate *body* bytes as well; metadata grouping
 * passes nullptr because only the argument budget applies.
 */
QVector<QStringList> groupPaths(const QStringList &paths, int limit,
                                const QHash<QString, Version> *versions = nullptr);

/** Validate an ordered NUL envelope; `partial` enables complete-prefix recovery. */
ParseResult parseBodies(const QString &output, const QStringList &paths, bool partial);

/**
 * Read every file's version, then its body when `needsBody` asks for it, and hand each
 * file to `consume` in the caller's order as soon as its group is complete.
 */
Outcome readBatches(const QStringList &files, const Execute &execute, const NeedsBody &needsBody,
                    const Consume &consume, const Options &options);

} // namespace wslscan
