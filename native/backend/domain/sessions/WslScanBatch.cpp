#include "WslScanBatch.h"

#include <QDateTime>
#include <QMutex>
#include <QMutexLocker>
#include <QRegularExpression>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <limits>
#include <thread>
#include <vector>

namespace wslscan {
namespace {

constexpr int kMetadataTimeoutMs = 5'000;
constexpr int kMaxBodyTimeoutMs = 10'000;
/** Leave a short settlement margin for summary parsing before the outer scan watchdog. */
constexpr int kDeadlineMarginMs = 100;
constexpr qint64 kMaxMetadataOutput = 1024 * 1024;

qint64 nowMs()
{
    return QDateTime::currentMSecsSinceEpoch();
}

bool aborted(const Options &options)
{
    return options.cancelled && options.cancelled();
}

/** Per-command budget: the body cap, reduced by whatever the scan deadline has left. */
int remainingMs(const Options &options, int cap)
{
    if (options.deadlineMs <= 0) return cap;
    const qint64 expiresAt = options.deadlineMs - kDeadlineMarginMs;
    const qint64 left = expiresAt - nowMs();
    if (left <= 0) return 0;
    return int(std::min<qint64>(cap, left));
}

/** Reject malformed stat fields rather than treating invalid metadata as a cache hit. */
bool fileVersion(const QString &time, const QString &size, Version *out)
{
    if (time.isEmpty() || size.isEmpty()) return false;
    bool timeOk = false;
    const double seconds = time.toDouble(&timeOk);
    bool sizeOk = false;
    const qint64 bytes = size.toLongLong(&sizeOk);
    // `Number.isSafeInteger(size)`: a value beyond 2^53-1 would lose precision in the
    // version key, and GNU stat never prints one.
    if (!timeOk || !sizeOk || !std::isfinite(seconds) || bytes < 0
        || bytes > (qint64(1) << 53) - 1) {
        return false;
    }
    // The oracle multiplies in a double and cannot overflow, but `qint64(seconds * 1000)`
    // is undefined outside the qint64 range — a corrupt or hostile `stat` printing 1e308
    // would reach that cast. Rejecting the record (and therefore the batch) is the only
    // safe answer; the per-file fallback rejects the same output.
    const double millis = seconds * 1000.0;
    if (!std::isfinite(millis) || millis < double(std::numeric_limits<qint64>::min())
        || millis > double(std::numeric_limits<qint64>::max())) {
        return false;
    }
    out->mtimeMs = qint64(millis);
    out->size = bytes;
    return true;
}

/**
 * Run `count` blocking jobs with at most `kConcurrency` child processes in flight.
 * Each job must only touch its own result slot, so no lock is needed inside the worker.
 */
void runWaves(int count, const std::function<void(int)> &work)
{
    for (int base = 0; base < count; base += kConcurrency) {
        const int end = std::min(count, base + kConcurrency);
        std::vector<std::thread> threads;
        threads.reserve(size_t(end - base));
        for (int index = base; index < end; ++index) {
            threads.emplace_back([&work, index] { work(index); });
        }
        for (std::thread &thread : threads) thread.join();
    }
}

/** Batch stat, then a bounded per-file fallback for whatever the batch did not resolve. */
QHash<QString, Version> readVersions(const QStringList &paths, const Execute &execute,
                                     const Options &options)
{
    QHash<QString, Version> versions;
    if (paths.isEmpty()) return versions;
    QStringList arguments{QStringLiteral("stat"), QStringLiteral("--printf"),
                          QStringLiteral("%n\\0%Y\\0%s\\0"), QStringLiteral("--")};
    arguments += paths;
    const sessioncmd::Result result = execute(arguments, kMetadataTimeoutMs, kMaxMetadataOutput);
    QStringList fields;
    bool batchOk = false;
    if (result.ok()) {
        fields = result.stdoutText.split(QLatin1Char('\0'));
        // A well-formed envelope ends with the trailing NUL and is a whole number of
        // (path, mtime, size) triples.
        batchOk = !fields.isEmpty() && fields.last().isEmpty() && (fields.size() - 1) % 3 == 0;
    }
    if (batchOk) {
        const QSet<QString> allowed(paths.begin(), paths.end());
        for (int index = 0; index < fields.size() - 1; index += 3) {
            Version version;
            if (!allowed.contains(fields.at(index))
                || !fileVersion(fields.at(index + 1), fields.at(index + 2), &version)) {
                // One malformed record invalidates the batch instead of half-trusting it.
                batchOk = false;
                break;
            }
            versions.insert(fields.at(index), version);
        }
    }
    if (!batchOk) versions.clear();
    QStringList missing;
    for (const QString &path : paths) {
        if (!versions.contains(path)) missing.append(path);
    }
    if (missing.isEmpty()) return versions;

    // Fallback reads must not spawn one process per file without a bound, so they use the
    // same concurrency window as the batch commands.
    std::vector<QHash<QString, Version>> batchSlots(size_t(missing.size()));
    const std::function<void(int)> statOne = [&missing, &batchSlots, &execute, &options](int index) {
        if (aborted(options)) return;
        const QString &path = missing.at(index);
        const sessioncmd::Result single =
            execute(QStringList{QStringLiteral("stat"), QStringLiteral("-c"),
                                QStringLiteral("%Y %s"), path},
                    5'000, kMaxMetadataOutput);
        if (!single.ok()) return;
        const QStringList parts = single.stdoutText.trimmed().split(QRegularExpression(QStringLiteral("\\s+")));
        if (parts.size() < 2) return;
        Version version;
        if (!fileVersion(parts.at(0), parts.at(1), &version)) return;
        batchSlots[size_t(index)].insert(path, version);
    };
    runWaves(missing.size(), statOne);
    for (const QHash<QString, Version> &slot : batchSlots) {
        for (auto iterator = slot.constBegin(); iterator != slot.constEnd(); ++iterator) {
            versions.insert(iterator.key(), iterator.value());
        }
    }
    return versions;
}

/** Read the bodies of `paths`; every path ends up with an explicit state. */
QHash<QString, Body> readBodies(const QStringList &paths, const Execute &execute,
                                const Options &options, bool *deadlineHit)
{
    QHash<QString, Body> bodies;
    for (const QString &path : paths) bodies.insert(path, Body{BodyState::Failed, QString()});
    if (paths.isEmpty()) return bodies;
    if (aborted(options)) return bodies;

    int budget = remainingMs(options, std::min(options.bodyTimeoutMs, kMaxBodyTimeoutMs));
    if (budget == 0) {
        *deadlineHit = true;
        return bodies;
    }
    QStringList pending = paths;
    if (paths.size() > 1) {
        qint64 headerBytes = 0;
        for (const QString &path : paths) headerBytes += path.toUtf8().size() + 16;
        QStringList arguments{QStringLiteral("sh"), QStringLiteral("-c"), readFilesScript(),
                              QStringLiteral("pideck-scan-read")};
        arguments += paths;
        const sessioncmd::Result result = execute(arguments, budget, kMaxBodyBytes + headerBytes);
        if (aborted(options)) return bodies;
        if (result.ok()) {
            const ParseResult parsed = parseBodies(result.stdoutText, paths, false);
            // A garbled envelope is a framing failure, not a timeout: the per-file reads
            // below are the safe fallback.
            if (parsed.ok) return parsed.bodies;
        } else if (result.timedOut) {
            const ParseResult parsed = parseBodies(result.stdoutText, paths, true);
            // No trustworthy attempted-file boundary: do not spend another full timeout.
            if (!parsed.ok) return bodies;
            const QStringList recovered = parsed.bodies.keys();
            for (const QString &path : recovered) bodies.insert(path, parsed.bodies.value(path));
            // Only the files the batch never started: the stalled cat is not repeated.
            pending = parsed.pending;
        }
    }

    // Budget snapshots are read per file, so a scan that ran out of deadline stops here.
    std::vector<QHash<QString, Body>> batchSlots(size_t(pending.size()));
    std::atomic<bool> expired{false};
    const std::function<void(int)> catOne = [&pending, &batchSlots, &execute, &options, &expired](int index) {
        if (aborted(options)) return;
        const int budget = remainingMs(options, std::min(options.bodyTimeoutMs, kMaxBodyTimeoutMs));
        if (budget == 0) {
            expired.store(true, std::memory_order_relaxed);
            return;
        }
        const QString &path = pending.at(index);
        const sessioncmd::Result result =
            execute(QStringList{QStringLiteral("cat"), path}, budget, kMaxBodyBytes);
        if (!result.ok()) return;
        Body body;
        body.state = BodyState::Success;
        body.text = result.stdoutText;
        batchSlots[size_t(index)].insert(path, body);
    };
    runWaves(pending.size(), catOne);
    if (expired.load(std::memory_order_relaxed)) *deadlineHit = true;
    for (const QHash<QString, Body> &slot : batchSlots) {
        for (auto iterator = slot.constBegin(); iterator != slot.constEnd(); ++iterator) {
            bodies.insert(iterator.key(), iterator.value());
        }
    }
    return bodies;
}

} // namespace

QString readFilesScript()
{
    // Paths are positional arguments, never interpolated into shell code. JSONL cannot
    // contain a literal NUL in valid JSON; malformed framing falls back to isolated,
    // budgeted cat reads with the same per-file ceiling.
    return QStringLiteral(
        "for file do printf \"%s\\0\" \"$file\"; cat -- \"$file\"; status=$?; "
        "printf \"\\0%s\\0\" \"$status\"; done");
}

QVector<QStringList> groupPaths(const QStringList &paths, int limit,
                               const QHash<QString, Version> *versions)
{
    QVector<QStringList> groups;
    QStringList group;
    qint64 argumentBytes = 0;
    qint64 bodyBytes = 0;
    for (const QString &path : paths) {
        const qint64 bytes = path.toUtf8().size() + 1;
        qint64 size = 0;
        if (versions) {
            const auto found = versions->constFind(path);
            size = found == versions->constEnd() ? kMaxBodyBytes : found->size;
        }
        if (!group.isEmpty()
            && (group.size() >= limit || argumentBytes + bytes > kMaxArgumentBytes
                || bodyBytes + size > kMaxBodyBytes)) {
            groups.append(group);
            group.clear();
            argumentBytes = 0;
            bodyBytes = 0;
        }
        group.append(path);
        argumentBytes += bytes;
        bodyBytes += size;
    }
    if (!group.isEmpty()) groups.append(group);
    return groups;
}

ParseResult parseBodies(const QString &output, const QStringList &paths, bool partial)
{
    ParseResult result;
    const QStringList fields = output.split(QLatin1Char('\0'));
    static const QRegularExpression digits(QStringLiteral("^\\d+$"));
    int index = 0;
    while (index < paths.size() && fields.size() >= index * 3 + 4) {
        const int from = index * 3;
        if (fields.at(from) != paths.at(index) || !digits.match(fields.at(from + 2)).hasMatch()) {
            return result;
        }
        const QString &text = fields.at(from + 1);
        Body body;
        body.state = fields.at(from + 2) == QLatin1String("0")
                && text.toUtf8().size() <= kMaxBodyBytes
            ? BodyState::Success
            : BodyState::Failed;
        if (body.state == BodyState::Success) body.text = text;
        result.bodies.insert(paths.at(index), body);
        index += 1;
    }
    const QStringList tail = fields.mid(index * 3);
    if (index == paths.size()) {
        if (tail.size() == 1 && tail.first().isEmpty()) {
            result.ok = true;
            return result;
        }
        return result;
    }
    if (!partial) return result;
    // A completed record boundary is also unambiguous: the next cat has not printed its
    // header yet.
    if (index > 0 && tail.size() == 1 && tail.first().isEmpty()) {
        result.ok = true;
        result.pending = paths.mid(index);
        return result;
    }
    // Only a terminated path header is evidence that this file was attempted. A cut header
    // or malformed NUL data is ambiguous, so callers conservatively skip timeout recovery.
    if (tail.size() != 2 || tail.first() != paths.at(index)) return result;
    result.bodies.insert(paths.at(index), Body{BodyState::Failed, QString()});
    result.pending = paths.mid(index + 1);
    result.ok = true;
    return result;
}

Outcome readBatches(const QStringList &files, const Execute &execute, const NeedsBody &needsBody,
                    const Consume &consume, const Options &options)
{
    if (aborted(options)) return Outcome::Cancelled;
    if (files.isEmpty()) return Outcome::Completed;

    QHash<QString, Version> versions;
    const QVector<QStringList> metadataGroups = groupPaths(files, kMetadataFiles);
    std::vector<QHash<QString, Version>> metadataSlots(size_t(metadataGroups.size()));
    const std::function<void(int)> metadataOne =
        [&metadataGroups, &metadataSlots, &execute, &options](int index) {
            if (aborted(options)) return;
            metadataSlots[size_t(index)] = readVersions(metadataGroups.at(index), execute, options);
        };
    runWaves(metadataGroups.size(), metadataOne);
    if (aborted(options)) return Outcome::Cancelled;
    for (const QHash<QString, Version> &slot : metadataSlots) {
        for (auto iterator = slot.constBegin(); iterator != slot.constEnd(); ++iterator) {
            versions.insert(iterator.key(), iterator.value());
        }
    }

    std::atomic<bool> deadlineHit{false};
    const QVector<QStringList> bodyGroups = groupPaths(files, kBodyFiles, &versions);
    // Groups run in waves, and a wave is consumed before the next one is requested: a scan
    // holds at most one wave of transcript text, never the whole tree.
    for (int base = 0; base < bodyGroups.size(); base += kConcurrency) {
        if (aborted(options)) return Outcome::Cancelled;
        const int end = std::min<int>(int(bodyGroups.size()), base + kConcurrency);
        struct GroupResult {
            QStringList wanted;
            QHash<QString, Body> bodies;
        };
        std::vector<GroupResult> results(size_t(end - base));
        std::vector<std::thread> threads;
        threads.reserve(size_t(end - base));
        for (int index = base; index < end; ++index) {
            threads.emplace_back([&bodyGroups, &results, &versions, &execute, &needsBody, &options,
                                  &deadlineHit, base, index] {
                GroupResult &slot = results[size_t(index - base)];
                for (const QString &path : bodyGroups.at(index)) {
                    const auto found = versions.constFind(path);
                    if (found == versions.constEnd()) continue;
                    if (needsBody && !needsBody(path, found.value())) continue;
                    slot.wanted.append(path);
                }
                bool groupExpired = false;
                slot.bodies = readBodies(slot.wanted, execute, options, &groupExpired);
                if (groupExpired) deadlineHit.store(true, std::memory_order_relaxed);
            });
        }
        for (std::thread &thread : threads) thread.join();
        // Consume on the caller's thread, in file order, so bodies die with the group.
        for (int index = base; index < end; ++index) {
            const GroupResult &result = results[size_t(index - base)];
            for (const QString &path : bodyGroups.at(index)) {
                FileRead read;
                const auto found = versions.constFind(path);
                if (found != versions.constEnd()) {
                    read.hasVersion = true;
                    read.version = found.value();
                    read.body = result.bodies.value(path, Body{BodyState::NotRequested, QString()});
                }
                consume(path, read);
            }
        }
    }
    if (aborted(options)) return Outcome::Cancelled;
    return deadlineHit.load(std::memory_order_relaxed) ? Outcome::Expired : Outcome::Completed;
}

} // namespace wslscan
