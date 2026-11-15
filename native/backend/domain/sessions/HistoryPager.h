#pragma once

#include "JsonlIndex.h"
#include "Projector.h"

#include <QJsonArray>
#include <QString>

/**
 * Bounded history paging (port of SessionHistoryReader's page functions).
 *
 * Two paging units share one cursor protocol: `before`/`nextBefore` are absolute
 * message indices in the JSONL active-branch space, and `nextBeforeEntryId` is the
 * only cross-space anchor (the runtime window and the file are different index spaces).
 *
 * `unit:"turn"` aligns page boundaries to `role === "user"` (or a visible task card,
 * see `findTurnPageStart`) so "load more" never cuts an answer in half; the byte budget
 * is a safety valve that drops whole turns from the oldest side, never splitting the
 * newest turn.
 */
namespace historypager {

constexpr int kMaxDisplayPageSize = 100;
constexpr qint64 kMaxDisplayPageBytes = 256 * 1024;
constexpr int kDefaultTurnPageSize = 3;
constexpr int kMaxTurnPageSize = 50;

struct Page {
    QJsonArray messages;
    int total = 0;
    bool hasNextBefore = false;
    int nextBefore = 0;
    QString nextBeforeEntryId;
    QString indexVersion;
};

/** Pure turn-start computation; exposed so the boundary rule is directly testable. */
int findTurnPageStart(const QVector<IndexEntry> &entries, int before, int turnCount, qint64 byteBudget);

Page readMessagePage(const JsonlIndex &index, const QString &agentId, int before, int pageSize,
                     const projector::Deps &deps);

Page readTurnPage(const JsonlIndex &index, const QString &agentId, int before, int turnCount,
                  const QString &beforeEntryId, const projector::Deps &deps);

/** Full, unpaged active-branch projection (sessions:catalog-read-messages). */
QJsonArray readAllMessages(const JsonlIndex &index, const QString &agentId, const projector::Deps &deps);

} // namespace historypager
