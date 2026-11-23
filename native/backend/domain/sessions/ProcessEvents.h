#pragma once

#include <QJsonArray>
#include <QString>

/**
 * Session process-event ledger (port of src/main/sessions/sessionProcessEvents.ts).
 *
 * Only non-message entries appear here: the conversation itself is already covered by
 * ChatMessage. Bad lines are skipped, and the ledger is bounded (240 events, 12 000
 * character detail clip) so a pathological session cannot blow up the RPC response.
 */
namespace processevents {

constexpr int kMaxEvents = 240;
constexpr int kDetailLimit = 12'000;

QJsonArray parse(const QString &raw);

} // namespace processevents
