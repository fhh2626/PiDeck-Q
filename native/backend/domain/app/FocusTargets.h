#pragma once

#include <QByteArray>
#include <QString>
#include <QStringList>

#include <optional>

/**
 * Focus targets carried by a `pideck://` activation and by the single-instance pipe.
 *
 * Port of `src/main/utils/focusTarget.ts` (URI normalization) and the payload half of
 * `src/main/singleInstance.ts` (`parseFocusPayload`). Both are pure functions so the
 * Windows toast activation, a secondary launch and the primary's pull channel all read
 * the same target instead of each parsing argv on its own.
 *
 * Accepted forms (case-insensitive scheme, UUID text preserved as written):
 *  - `pideck://session/<uuid>` — the primary form; the toast embeds the stable
 *    `SessionRecord.id`, so a click resolves after a restart;
 *  - `pideck://agent/<uuid>` — legacy toasts; the agent id only resolves while that
 *    runtime is still bound, so the caller maps it through the coordinator first.
 * No match means "just focus the window", never an error.
 */
namespace appfocus {

struct Target {
    QString sessionId;
    QString agentId;

    bool isEmpty() const { return sessionId.isEmpty() && agentId.isEmpty(); }
};

/** `{at, fromPid, argv}` envelope a secondary instance forwards to the primary. */
struct Payload {
    qint64 at = 0;
    qint64 fromPid = 0;
    QStringList argv;
};

/**
 * Largest focus payload including the newline delimiter (64 KiB).
 *
 * A named pipe is a trust boundary owned by another process on the same machine, so the
 * reader caps what it will buffer instead of growing with whatever the peer writes.
 */
constexpr int kMaxPayloadBytes = 64 * 1024;

/** First `pideck://session/` match wins over the legacy `pideck://agent/` form. */
std::optional<Target> extractFocusTarget(const QStringList &argv);

/** Parse one forwarded payload; a malformed envelope yields no focus request at all. */
std::optional<Payload> parseFocusPayload(const QByteArray &raw);

/** Compact JSON for the wire; contains no trailing newline (the sender appends it). */
QByteArray encodeFocusPayload(const Payload &payload);

} // namespace appfocus
