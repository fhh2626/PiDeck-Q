// Real threaded regression for the session catalog's cross-thread ownership (CAT-1).
//
// Why this is a native test: the defect is a data race, so the only faithful oracle is
// the production `SessionCatalogStore` driven from two real threads at once. The backend
// reaches the store from the Qt owner thread (runtime activation, project channels) and
// from the serial domain executor (`sessions:catalog-*` bodies, background scans); the
// store itself used to be completely unsynchronised, so
//   - `mutate()` / `mergeScanned()` perform copy → write → assign on `m_entries` and a
//     concurrently created draft could be dropped by the second assign (lost update);
//   - `listEntries()` copies the vector while another thread appends to it (torn read,
//     refcount double-free, or a crash);
//   - `writeSnapshot()` runs unsynchronised, and `sessionfiles::renameWithRetry` removes
//     the destination before renaming, so two writers could leave no catalog file at all.
//
// Every case below drives the public API only (no internals, no test hooks) and asserts
// observable invariants: no record may be lost, no duplicate identity may appear, the
// durable file must always parse and hold every surviving id, and a status snapshot must
// never mix two identity contexts. Exit code 0 plus one `ok - <case>` line per assertion;
// any failure prints `not ok - ...` and exits 1, so
// `tests/native2CatalogConcurrencyParity.test.mjs` can assert on the public output.
#include "SessionCatalogStore.h"
#include "SessionSummary.h"

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QString>
#include <QTemporaryDir>
#include <QThread>
#include <QVector>

#include <atomic>
#include <cstdio>
#include <memory>
#include <thread>
#include <vector>

namespace {

int g_failures = 0;

void check(bool condition, const char *name, const QString &detail = QString())
{
    if (condition) {
        std::printf("ok - %s\n", name);
        // Flush per assertion: an unsynchronised store can crash mid-run, and the partial
        // output is the evidence of which invariant broke first.
        std::fflush(stdout);
        return;
    }
    std::printf("not ok - %s (%s)\n", name, detail.toUtf8().constData());
    std::fflush(stdout);
    ++g_failures;
}

QString pathOf(const QTemporaryDir &directory)
{
    return QDir(directory.path()).filePath(QStringLiteral("session-catalog.json"));
}

SessionSummary summaryFor(const QString &filePath, qint64 updatedAt, const QString &name = QString())
{
    SessionSummary summary;
    summary.filePath = filePath;
    summary.updatedAt = updatedAt;
    summary.hasName = !name.isEmpty();
    summary.name = name;
    summary.messageCount = 2;
    summary.preview = QStringLiteral("preview");
    return summary;
}

QSet<QString> idsOf(const QVector<CatalogEntry> &entries)
{
    QSet<QString> ids;
    for (const CatalogEntry &entry : entries) ids.insert(entry.id);
    return ids;
}

/** Ids the durable catalog file holds; an unreadable file reports empty. */
QSet<QString> durableIds(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return {};
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll());
    if (!document.isObject()) return {};
    QSet<QString> ids;
    for (const QJsonValue &value : document.object().value(QStringLiteral("sessions")).toArray()) {
        const QString id = value.toObject().value(QStringLiteral("id")).toString();
        if (!id.isEmpty()) ids.insert(id);
    }
    return ids;
}

QString describe(const QSet<QString> &expected, const QSet<QString> &actual)
{
    return QStringLiteral("expected %1, saw %2 (missing %3)")
        .arg(expected.size())
        .arg(actual.size())
        .arg(expected.size() - actual.size());
}

/**
 * One iteration budget large enough to interleave reliably on a multicore machine: the
 * unlocked store loses an update (or tears the vector) within a handful of rounds, so a
 * fail-open threshold would be dishonest — every round must survive.
 */
constexpr int kRounds = 240;

/** The only refusal a losing attach may produce (`SessionCatalogStore::requireEntry`). */
const QString kNotFoundPrefix = QStringLiteral("Session not found: ");

// ── case 1: the mergeScanned copy/write/assign transaction vs concurrent drafts ──
//
// `mergeScanned` copies `m_entries`, writes the copy and then assigns it back. A draft
// created by another thread between the copy and the assign belongs to the *old* vector,
// so the assign silently deletes it: the sidebar loses a session the user just typed.
void mergeScannedNeverDropsConcurrentDrafts()
{
    QTemporaryDir directory;
    check(directory.isValid(), "scratch directory created");
    SessionCatalogStore store(pathOf(directory), SessionCatalogStore::Context{});
    store.load();

    QVector<SessionSummary> summaries;
    for (int index = 0; index < 12; ++index) {
        summaries.append(summaryFor(QStringLiteral("C:/sessions/scan-%1.jsonl").arg(index),
                                    1'700'000'000'000LL + index));
    }

    std::vector<QString> draftIds;
    draftIds.reserve(kRounds);
    std::atomic<bool> start{false};
    std::thread scanner([&] {
        while (!start.load(std::memory_order_acquire)) {
            std::this_thread::yield();
        }
        for (int round = 0; round < kRounds; ++round) {
            // Alternate the payload so the merge really rewrites the file each round.
            QVector<SessionSummary> batch = summaries;
            if (round % 2 == 1) {
                batch.append(summaryFor(QStringLiteral("C:/sessions/scan-extra-%1.jsonl").arg(round),
                                        1'700'000'001'000LL + round));
            }
            store.mergeScanned(QStringLiteral("p1"), batch, SessionCatalogStore::Context{});
        }
    });
    std::thread drafter([&] {
        while (!start.load(std::memory_order_acquire)) {
            std::this_thread::yield();
        }
        for (int round = 0; round < kRounds; ++round) {
            const QJsonObject draft = store.createDraft(
                QStringLiteral("p1"), QStringLiteral("Draft %1").arg(round), QStringLiteral("native"),
                QStringLiteral("pi"), false, QString(), QString(), false, QString());
            draftIds.push_back(draft.value(QStringLiteral("id")).toString());
        }
    });
    start.store(true, std::memory_order_release);
    scanner.join();
    drafter.join();

    const QSet<QString> seen = idsOf(store.listEntries());
    QSet<QString> missing;
    int lost = 0;
    for (const QString &id : draftIds) {
        if (!seen.contains(id)) {
            ++lost;
            missing.insert(id);
        }
    }
    check(lost == 0, "every draft created during a scan survives the merge",
          QStringLiteral("%1 of %2 drafts were dropped").arg(lost).arg(draftIds.size()));
    check(!seen.isEmpty(), "the merged catalog is not empty");
    // `mergeScanned` returns the project's records; a lost draft must also be absent there.
    const QJsonArray records = store.listProjectRecords(QStringLiteral("p1"));
    QSet<QString> recordIds;
    for (const QJsonValue &value : records) recordIds.insert(value.toObject().value(QStringLiteral("id")).toString());
    check(recordIds.size() == seen.size(), "the project record list matches the store",
          describe(seen, recordIds));

    // The durable file is the other half of the transaction: after the storm it must
    // parse and hold every non-transient record (a torn or half-renamed file is a data
    // loss on the next launch).
    const QSet<QString> onDisk = durableIds(pathOf(directory));
    QSet<QString> durableExpected;
    for (const CatalogEntry &entry : store.listEntries()) {
        if (entry.status == QLatin1String("draft") || entry.noSession) continue;
        durableExpected.insert(entry.id);
    }
    check(!onDisk.isEmpty(), "the catalog file was written");
    const QSet<QString> missingFromDisk = durableExpected - onDisk;
    check(missingFromDisk.isEmpty(), "the durable catalog holds every persisted record",
          describe(durableExpected, onDisk));
}

// ── case 2: readers while writers mutate ──
//
// `listEntries`/`get`/`listRecords` run on the owner thread (runtime activation, project
// sidebar) while catalog mutations run on the executor. An unsynchronised copy of
// `m_entries` while a writer replaces it is a torn read — a crash or a bogus record set.
void readersNeverObserveATornCatalog()
{
    QTemporaryDir directory;
    SessionCatalogStore store(pathOf(directory), SessionCatalogStore::Context{});
    store.load();

    const QString seeded = store.createDraft(QStringLiteral("p1"), QStringLiteral("seed"),
                                             QStringLiteral("native"), QStringLiteral("pi"), false,
                                             QString(), QString(), false, QString())
                               .value(QStringLiteral("id"))
                               .toString();
    std::atomic<bool> start{false};
    std::atomic<int> reads{0};
    std::atomic<bool> inconsistent{false};
    std::thread writer([&] {
        while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
        for (int round = 0; round < kRounds; ++round) {
            const QJsonObject draft = store.createDraft(
                QStringLiteral("p1"), QStringLiteral("w%1").arg(round), QStringLiteral("native"),
                QStringLiteral("pi"), false, QString(), QString(), false, QString());
            const QString id = draft.value(QStringLiteral("id")).toString();
            QJsonObject patch;
            patch.insert(QStringLiteral("title"), QStringLiteral("renamed %1").arg(round));
            store.update(id, patch);
        }
    });
    std::thread reader([&] {
        while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
        for (int round = 0; round < kRounds * 4; ++round) {
            const QVector<CatalogEntry> entries = store.listEntries();
            QSet<QString> ids;
            for (const CatalogEntry &entry : entries) {
                if (ids.contains(entry.id)) inconsistent.store(true, std::memory_order_release);
                ids.insert(entry.id);
            }
            CatalogEntry one;
            if (!store.get(seeded, &one)) {
                // The seeded draft is never removed, so it must always be readable.
                inconsistent.store(true, std::memory_order_release);
            }
            store.listRecords(QStringLiteral("p1"));
            reads.fetch_add(1, std::memory_order_release);
        }
    });
    start.store(true, std::memory_order_release);
    writer.join();
    reader.join();

    check(reads.load() > 0, "the reader thread completed its snapshots");
    check(!inconsistent.load(), "no torn read: ids stay unique and the seeded record stays visible");
    check(store.get(seeded, nullptr), "the seeded record survived the concurrent storm");
}

// ── case 3: attach + remove from two threads ──
//
// `attachRuntime` merges duplicate origin keys (it removes the duplicate while assigning)
// and `remove` deletes a record; both are copy/write/assign transactions. Interleaving them
// used to resurrect a deleted record or lose the attached one.
void attachAndRemoveStayConsistent()
{
    QTemporaryDir directory;
    SessionCatalogStore store(pathOf(directory), SessionCatalogStore::Context{});
    store.load();

    QVector<QString> ids;
    for (int index = 0; index < 40; ++index) {
        const QJsonObject draft = store.createDraft(
            QStringLiteral("p1"), QStringLiteral("a%1").arg(index), QStringLiteral("native"),
            QStringLiteral("pi"), false, QString(), QString(), false, QString());
        ids.append(draft.value(QStringLiteral("id")).toString());
    }

    std::atomic<bool> start{false};
    std::atomic<int> attachOk{0};
    std::atomic<int> attachNotFound{0};
    // A permanently removed id is the deterministic not-found witness: the attacher targets
    // it every 8th round, so a real not-found exists no matter how the two threads are
    // scheduled (an assertion that *may* be satisfied by zero events is not a regression).
    const QString removedId = ids.takeFirst();
    store.remove(removedId);
    // Written by the attacher only, read after join. Any exception other than the store's
    // not-found is a regression of the fence (a load-order assertion, a JSON/I-O error from
    // a torn write) and must never be counted as a tolerated race.
    QString unexpectedFailure;
    std::thread attacher([&] {
        while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
        for (int round = 0; round < kRounds; ++round) {
            const QString id =
                round % 8 == 0 ? removedId : ids.at(round % ids.size());
            try {
                store.attachRuntime(id, QStringLiteral("C:/sessions/attach-%1.jsonl").arg(round),
                                    QStringLiteral("pi-%1").arg(round));
                attachOk.fetch_add(1, std::memory_order_relaxed);
            } catch (const std::exception &error) {
                const QString message = QString::fromUtf8(error.what());
                if (!message.startsWith(kNotFoundPrefix)) {
                    unexpectedFailure = message;
                    return;
                }
                attachNotFound.fetch_add(1, std::memory_order_relaxed);
            }
        }
    });
    std::thread remover([&] {
        while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
        for (int round = 0; round < kRounds; ++round) {
            const QString id = ids.at(ids.size() - 1 - (round % ids.size()));
            store.remove(id);
        }
    });
    start.store(true, std::memory_order_release);
    attacher.join();
    remover.join();
    const int bound = attachOk.load();
    const int notFound = attachNotFound.load();
    check(unexpectedFailure.isEmpty(), "attach only ever fails with the store's clean not-found",
          unexpectedFailure);
    // Falsifiable budget: every round either bound the record or reported not-found. The
    // previous assertion (`not-found <= rounds`) compared a counter that increments at most
    // once per iteration with the iteration count, so it could never fail while the suite
    // reported the case as covered.
    check(bound + notFound == kRounds, "every attach either bound the record or reported not-found",
          QStringLiteral("%1 bound + %2 not-found != %3 rounds").arg(bound).arg(notFound).arg(kRounds));
    check(notFound > 0, "a concurrently removed id is really reported as a clean not-found",
          QStringLiteral("%1 not-found answers").arg(notFound));

    const QVector<CatalogEntry> entries = store.listEntries();
    QSet<QString> unique;
    bool duplicate = false;
    for (const CatalogEntry &entry : entries) {
        if (unique.contains(entry.id)) duplicate = true;
        unique.insert(entry.id);
    }
    check(!duplicate, "attach/remove never resurrects a duplicate identity");
    check(unique.size() == entries.size(), "the record vector has no duplicated id");
    // A removal that won must stay removed: the remover deleted every id, so nothing the
    // attacher did may bring one back.
    int resurrected = 0;
    for (const QString &id : ids) {
        if (store.get(id, nullptr)) ++resurrected;
    }
    check(resurrected == 0, "a removed record is never resurrected by a concurrent attach",
          QStringLiteral("%1 ids came back").arg(resurrected));
}

// ── case 4: the identity context is one coherent pair ──
//
// `originKeyForEntry` and draft creation read the WSL identity. A reader that observes a
// half-applied context builds `pi:wsl:<newDistro>:<oldUser>:…` and splits one file into
// two records on the next scan.
void identityContextIsACoherentPair()
{
    QTemporaryDir directory;
    SessionCatalogStore store(pathOf(directory), SessionCatalogStore::Context{});
    store.load();

    std::atomic<bool> start{false};
    std::atomic<bool> torn{false};
    std::thread writer([&] {
        while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
        for (int round = 0; round < kRounds * 8; ++round) {
            SessionCatalogStore::Context context;
            context.wslDistro = QStringLiteral("Distro%1").arg(round % 3);
            context.wslUser = QStringLiteral("User%1").arg(round % 3);
            store.setIdentityContext(context);
        }
    });
    std::thread reader([&] {
        while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
        for (int round = 0; round < kRounds * 8; ++round) {
            const SessionCatalogStore::Context context = store.identityContext();
            const QString distroSuffix = context.wslDistro.right(1);
            const QString userSuffix = context.wslUser.right(1);
            if (!distroSuffix.isEmpty() && distroSuffix != userSuffix) {
                torn.store(true, std::memory_order_release);
            }
        }
    });
    start.store(true, std::memory_order_release);
    writer.join();
    reader.join();
    check(!torn.load(), "an identity context read is never a mix of two publications");
}

/** A summary collected before deletion must not recreate the removed path under a new id. */
void staleScanCannotResurrectDeletion()
{
    QTemporaryDir directory;
    SessionCatalogStore store(pathOf(directory), {});
    store.load();
    const QVector<SessionSummary> summaries{summaryFor(QStringLiteral("C:/sessions/deleted.jsonl"), 1)};
    const QJsonArray initial = store.mergeScanned(QStringLiteral("p1"), summaries, {});
    const quint64 collectedGeneration = store.scanGeneration();
    // This ordering is the deterministic owner-thread deletion / worker merge race.
    store.remove(initial.at(0).toObject().value(QStringLiteral("id")).toString());
    const QJsonArray stale = store.mergeScanned(QStringLiteral("p1"), summaries, {}, collectedGeneration);
    check(stale.isEmpty(), "a stale scan cannot resurrect a successfully deleted path");
    check(store.listEntries().isEmpty() && durableIds(pathOf(directory)).isEmpty(),
          "stale scan rejection also preserves the durable catalog");
    const QJsonArray fresh = store.mergeScanned(QStringLiteral("p1"), summaries, {}, store.scanGeneration());
    check(fresh.size() == 1, "a new scan can discover a genuinely recreated session path");
}

} // namespace

int main()
{
    mergeScannedNeverDropsConcurrentDrafts();
    readersNeverObserveATornCatalog();
    attachAndRemoveStayConsistent();
    identityContextIsACoherentPair();
    staleScanCannotResurrectDeletion();

    if (g_failures != 0) {
        std::printf("%d failure(s)\n", g_failures);
        return 1;
    }
    std::printf("all session catalog concurrency cases passed\n");
    return 0;
}
