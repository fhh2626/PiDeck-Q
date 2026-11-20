#pragma once

#include "../MainCopy.h"

#include <QJsonArray>
#include <QJsonValue>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QVector>

#include <functional>

/**
 * Persisted pi/RPC history → renderer ChatMessage records.
 *
 * Port of src/main/pi/AgentMessageProjector.ts. It owns no process or session state:
 * the caller supplies the active-branch entry ids and the branch-wide tool-result ids
 * so paged reads keep tool pairing correct across pages.
 */
namespace projector {

struct Deps {
    maincopy::Translator translate;
    /** Live runtime only: a cancelled ask must render as cancelled, not answered. */
    std::function<bool(const QString &agentId)> isAskAborted;
};

/** Maximum characters kept for one tool detail section (oracle: 8000). */
constexpr int kMaxToolResultChars = 8000;

/** Matched IDs are indexed by raw message; legacy callers supply only ordinary file slots. */
enum class EntryIdLayout { Legacy, Matched };

QJsonArray convert(const QString &agentId, const QVector<QJsonValue> &rawMessages,
                   const QStringList &activeEntryIds, const QSet<QString> &knownToolResultIds,
                   const Deps &deps, EntryIdLayout layout = EntryIdLayout::Legacy);

/** Insert one compaction card at the page-relative boundary (pager helper). */
QJsonObject compactionCard(const QString &agentId, const QString &summary, qint64 timestamp,
                           const QString &compactionId, const QString &firstKeptEntryId, bool hasTokensBefore,
                           qint64 tokensBefore, int compactionCount);

/** Head/tail truncation with the localized "omitted" marker. */
QString truncateForDetail(const QString &text, const maincopy::Translator &translate);

/** JSON with base64 image payloads replaced by a length marker. */
QString safeJson(const QJsonValue &value);

/**
 * Runtime projection helpers (same implementations the history projector uses).
 * The live agent needs them to build ChatMessage rows from pi events without a file.
 */
QString messageThinking(const QJsonValue &content);
QString toolResultText(const QJsonValue &result, const maincopy::Translator &translate);
QString toolDetail(const QString &toolName, const QJsonValue &args, const QJsonValue &result,
                   bool isError, bool missingResult, const maincopy::Translator &translate);

} // namespace projector
