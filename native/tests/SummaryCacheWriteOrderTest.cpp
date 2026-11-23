// Deterministic regression for the session-summary cache write ordering.
//
// Why this is a native test and not an end-to-end one: the end-to-end race needs a
// debounced payload to still be queued when shutdown's `flush()` persists a newer
// snapshot, and every construction of that window through the public backend (timer
// jitter, cross-channel dispatch order, a blocking executor body) turned out to be a
// coin flip — the same binary flipped green/red. The rule itself is pure, so it is
// tested directly: `WriteOrdering` is the production gate both writers go through, and
// the test drives it in exactly the order that used to roll the cache back.
//
// Exit code 0 and one `ok - <case>` line per case; any failure prints `not ok - ...`
// and exits 1, so `tests/native2SummaryCacheWriteOrder.test.mjs` can assert on the
// public output instead of parsing a stack.
#include "WriteOrdering.h"

#include <QByteArray>
#include <QDir>
#include <QString>

#include <cstdio>
#include <functional>
#include <memory>
#include <vector>

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

/** Writer that records what would have been written, newest last. */
struct Recorder {
    std::vector<QByteArray> payloads;
    bool failNext = false;

    std::function<bool(const QByteArray &)> writer()
    {
        return [this](const QByteArray &payload) {
            if (failNext) {
                failNext = false;
                return false;
            }
            payloads.push_back(payload);
            return true;
        };
    }

    QByteArray last() const { return payloads.empty() ? QByteArray() : payloads.back(); }
};

} // namespace

int main()
{
    using summarycache::WriteOrdering;
    using summarycache::WriteState;

    // 1. The shutdown race: the debounced snapshot (sequence 1) is still queued when
    //    `flush()` writes the newest one (sequence 3). When the stale payload finally
    //    runs it must not land, and the caller is still told "it is on disk".
    {
        auto state = std::make_shared<WriteState>();
        Recorder recorder;
        WriteOrdering ordering(state, recorder.writer());
        check(ordering.write("{\"entries\":{\"a\":1}}", 3), "flush writes the newest snapshot", "3 rejected");
        check(ordering.write("{\"entries\":{}}", 1), "a stale queued payload reports success", "1 failed");
        check(recorder.payloads.size() == 1, "a stale queued payload is never written", "older payload hit the file");
        check(recorder.last() == QByteArray("{\"entries\":{\"a\":1}}"), "disk keeps the newest payload",
              recorder.last().constData());
        check(ordering.persistedSequence() == 3, "the persisted sequence stays the newest", "sequence regressed");
    }

    // 2. In-order writes still work: a later scan must be able to replace the file.
    {
        auto state = std::make_shared<WriteState>();
        Recorder recorder;
        WriteOrdering ordering(state, recorder.writer());
        check(ordering.write("v1", 1), "first snapshot is written", "1 rejected");
        check(ordering.write("v2", 2), "a newer snapshot is written", "2 rejected");
        check(recorder.payloads.size() == 2 && recorder.last() == QByteArray("v2"),
              "the newer snapshot is the last one on disk", "wrong content");
        check(ordering.persistedSequence() == 2, "the persisted sequence advances", "sequence stale");
    }

    // 3. The same sequence twice (debounce + flush carrying one snapshot) rewrites once:
    //    the duplicate would only add a rename, and the cache relies on this to decide
    //    whether it is still dirty.
    {
        auto state = std::make_shared<WriteState>();
        Recorder recorder;
        WriteOrdering ordering(state, recorder.writer());
        check(ordering.write("same", 4), "equal-sequence write reports success", "4 rejected");
        check(ordering.write("same", 4), "a repeated snapshot is superseded", "duplicate written");
        check(recorder.payloads.size() == 1, "a repeated snapshot is not rewritten", "duplicate hit the file");
    }

    // 4. A failed write must not advance the sequence (the cache stays dirty and its next
    //    attempt has to be able to land), and a newer sequence afterwards still writes.
    {
        auto state = std::make_shared<WriteState>();
        Recorder recorder;
        WriteOrdering ordering(state, recorder.writer());
        recorder.failNext = true;
        check(!ordering.write("lost", 5), "a failed write reports failure", "failure swallowed");
        check(ordering.persistedSequence() == 0, "a failed write does not advance the sequence", "sequence advanced");
        check(ordering.write("kept", 6), "the retry with a newer sequence writes", "retry rejected");
        check(recorder.last() == QByteArray("kept"), "the retry is what lands on disk", "wrong content");
    }

    // 5. Two writers sharing one state (the real shape: executor body + shutdown flush)
    //    cannot interleave into a rollback, whichever order they run in.
    {
        auto state = std::make_shared<WriteState>();
        Recorder recorder;
        WriteOrdering debounce(state, recorder.writer());
        WriteOrdering flush(state, recorder.writer());
        check(flush.write("newest", 9), "the flush path writes", "9 rejected");
        check(debounce.write("older", 8), "the queued body reports success", "8 failed");
        check(recorder.last() == QByteArray("newest"), "one shared state keeps the newest payload", "rollback");
    }

    if (g_failures != 0) {
        std::printf("%d failure(s)\n", g_failures);
        return 1;
    }
    std::printf("all write-ordering cases passed\n");
    return 0;
}
