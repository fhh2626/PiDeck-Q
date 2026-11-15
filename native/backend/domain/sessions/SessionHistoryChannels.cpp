#include "SessionChannelSupport.h"

#include "HistoryText.h"
#include "ProcessEvents.h"
#include "SessionFiles.h"
#include "TemporaryPiSession.h"

#include "../runtime/DeliveryBudget.h"
#include "../runtime/RuntimeCoordinator.h"

#include <QJsonArray>
#include <QJsonObject>

namespace {

/** Max ids accepted by the batch tool-payload channel (oracle bound). */
constexpr int kMaxToolPayloadIds = 200;

/** A catalog entry that actually points at a session file; false for drafts/unknown ids. */
bool hasSessionFile(const CatalogEntry &entry)
{
    return !entry.filePath.isEmpty();
}

/**
 * Existing JSONL for an entry. The oracle's file readers throw when the file vanished
 * between the catalog read and the IO, so a missing file is an error, not an empty page.
 */
QString requireExistingFile(const ChannelServices &services, const QString &filePath)
{
    if (!sessionchannels::scannerOf(services).fs().exists(filePath)) {
        throw ChannelError(sessionchannels::translateOf(services)(
            QStringLiteral("session.fileNotFound"), QJsonObject{}));
    }
    return filePath;
}

/** Entry-based JSONL lookup for the channels that only accept persisted sessions. */
QString requireSessionFile(const ChannelServices &services, const QString &sessionId)
{
    const CatalogEntry entry = sessionchannels::requireEntry(services, sessionId);
    return requireExistingFile(services, entry.filePath);
}

/**
 * File the tool-payload channels read when the catalog has no path yet.
 *
 * A draft/anonymous session can own a live runtime whose pi process already writes a
 * session file; the catalog record catches up asynchronously (`attachRuntime`). The
 * oracle therefore falls back to the runtime's sessionPath instead of erroring, so tool
 * cards in a not-yet-flushed live session can still expand.
 */
QString runtimeSessionFile(const ChannelServices &services, const QString &sessionId)
{
    if (!services.runtimeCoordinator) return QString();
    return services.runtimeCoordinator->runtimeSessionPath(sessionId);
}

/**
 * Index for a payload read. The oracle's `readToolExportPayloads` wraps the whole read in
 * try/catch and returns an empty map, so a vanished/unreadable file yields `null` / `{}`
 * here as well instead of surfacing a raw IO error through the IPC boundary.
 */
bool payloadIndex(const ChannelServices &services, const QString &filePath, JsonlIndex *index)
{
    try {
        *index = sessionchannels::indexFor(services, filePath);
        return true;
    } catch (const std::exception &) {
        return false;
    }
}

QJsonObject toolPayloadJson(const historytext::ToolExportPayload &payload)
{
    QJsonObject result;
    if (payload.hasArgsText) result.insert(QStringLiteral("argsText"), payload.argsText);
    if (payload.hasResultText) result.insert(QStringLiteral("resultText"), payload.resultText);
    if (payload.hasDetailsText) result.insert(QStringLiteral("detailsText"), payload.detailsText);
    return result;
}

/** Empty page shape the oracle returns for a draft or an unknown session id. */
QJsonObject emptyPage()
{
    return sessionchannels::pageJson(historypager::Page{});
}

/**
 * Apply the oracle's page delivery budget (`enforceDeliveryBudgetOnPage`).
 *
 * Two effects: tool `meta.result` copies never reach the renderer, and a page with images
 * that exceeds 30 MiB is degraded one message at a time. When even the stripped page does
 * not fit, the IPC call rejects with the oracle's exact `MESSAGE_DELIVERY_TOO_LARGE`
 * message instead of silently dropping the frame at the transport layer.
 */
QJsonValue budgetedPage(const QJsonObject &page)
{
    const deliverybudget::Outcome outcome =
        deliverybudget::enforcePage(page, deliverybudget::configuredMaxBytes());
    if (!outcome.ok) throw ChannelError(outcome.code);
    return outcome.value;
}

} // namespace

void registerSessionHistoryChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("sessions:catalog-read-messages"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString sessionId = channels::stringArg(args, 0);
                          sessionchannels::runAsync(responder, [&services, sessionId]() -> QJsonValue {
                              // `SessionRecordService.readMessages` returns [] when the record is
                              // missing or is a draft: an empty timeline, never a spurious error.
                              CatalogEntry entry;
                              if (!sessionchannels::findEntry(services, sessionId, &entry)
                                  || !hasSessionFile(entry)) {
                                  return QJsonArray{};
                              }
                              const QString filePath = requireExistingFile(services, entry.filePath);
                              const JsonlIndex index = sessionchannels::indexFor(services, filePath);
                              // File-backed reads use the stable session id as the agent namespace,
                              // exactly like the oracle (readSessionDisplay*Page(entry.filePath, sessionId, ...)).
                              return historypager::readAllMessages(index, sessionId,
                                                                   sessionchannels::projectorDeps(services));
                          });
                      });

    registry.addAsync(QStringLiteral("sessions:catalog-read-message-page"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString sessionId = channels::stringArg(args, 0);
                          const QJsonValue before = channels::argAt(args, 1);
                          const QJsonValue pageSize = channels::argAt(args, 2);
                          const QJsonObject options = channels::objectArg(args, 3);
                          sessionchannels::runAsync(responder,
                                                    [&services, sessionId, before, pageSize, options]() -> QJsonValue {
                              CatalogEntry entry;
                              if (!sessionchannels::findEntry(services, sessionId, &entry)
                                  || !hasSessionFile(entry)) {
                                  return emptyPage();
                              }
                              const QString filePath = requireExistingFile(services, entry.filePath);
                              const bool turnUnit = options.value(QStringLiteral("unit")).toString()
                                  == QLatin1String("turn");
                              const QString beforeEntryId =
                                  options.value(QStringLiteral("beforeEntryId")).toString();
                              const int effectivePageSize =
                                  pageSize.isDouble()
                                  ? pageSize.toInt()
                                  : (turnUnit ? historypager::kDefaultTurnPageSize
                                              : historypager::kMaxDisplayPageSize);
                              // Runtime-cache-first (oracle `tryReadRuntimeTurnPage`): only when the
                              // renderer sends a cursor, because the initial tail page must come from
                              // the file's authoritative end. Rows are served from the live window but
                              // both cursors stay in the file index space.
                              if (turnUnit && (before.isDouble() || !beforeEntryId.isEmpty())
                                  && services.runtimeCoordinator) {
                                  historypager::Page cached;
                                  if (services.runtimeCoordinator->tryReadRuntimeTurnPage(
                                          sessionId, filePath, beforeEntryId, before.isDouble(),
                                          before.isDouble() ? before.toInt() : 0, effectivePageSize,
                                          &cached)) {
                                      return budgetedPage(sessionchannels::pageJson(cached));
                                  }
                              }
                              const JsonlIndex index = sessionchannels::indexFor(services, filePath);
                              // No `before` means "the newest page": the pager treats it as an
                              // exclusive end index, so the first call starts at the total.
                              const int cursor = before.isDouble() ? before.toInt()
                                                                   : index.activeMessageEntries.size();
                              const historypager::Page page = turnUnit
                                  ? historypager::readTurnPage(index, sessionId, cursor,
                                                               effectivePageSize, beforeEntryId,
                                                               sessionchannels::projectorDeps(services))
                                  : historypager::readMessagePage(index, sessionId, cursor,
                                                                  effectivePageSize,
                                                                  sessionchannels::projectorDeps(services));
                              return budgetedPage(sessionchannels::pageJson(page));
                          });
                      });

    registry.addAsync(QStringLiteral("sessions:catalog-read-process-events"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString sessionId = channels::stringArg(args, 0);
                          sessionchannels::runAsync(responder, [&services, sessionId]() -> QJsonValue {
                              if (sessionId.trimmed().isEmpty()) return QJsonArray{};
                              CatalogEntry entry;
                              if (!sessionchannels::findEntry(services, sessionId, &entry)
                                  || !hasSessionFile(entry)) {
                                  return QJsonArray{};
                              }
                              QString raw;
                              QString error;
                              if (!sessionfiles::readText(requireExistingFile(services, entry.filePath), &raw,
                                                          &error)) {
                                  throw ChannelError(error);
                              }
                              return processevents::parse(raw);
                          });
                      });

    registry.addAsync(QStringLiteral("sessions:catalog-read-message-full-text"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString sessionId = channels::stringArg(args, 0);
                          const QString messageId = channels::stringArg(args, 2);
                          const QString entryId = channels::stringArg(args, 3);
                          sessionchannels::runAsync(responder, [&services, sessionId, messageId, entryId]() -> QJsonValue {
                              // Oracle ladder: the live runtime first (untruncated tool cache,
                              // then the file its process is writing), then the catalog record's
                              // file. A draft whose pi has not flushed yet has no catalog path,
                              // so without the live steps its tool cards could never expand.
                              if (services.runtimeCoordinator && !messageId.isEmpty()) {
                                  const QString cached =
                                      services.runtimeCoordinator->liveToolFullText(sessionId, messageId);
                                  if (!cached.isEmpty()) {
                                      return QJsonObject{{QStringLiteral("text"), cached}};
                                  }
                              }
                              QStringList candidates;
                              const QString runtimePath = runtimeSessionFile(services, sessionId);
                              if (!runtimePath.isEmpty()) candidates.append(runtimePath);
                              CatalogEntry entry;
                              if (sessionchannels::findEntry(services, sessionId, &entry)
                                  && !entry.filePath.isEmpty()
                                  && !candidates.contains(entry.filePath)) {
                                  candidates.append(entry.filePath);
                              }
                              for (const QString &candidate : candidates) {
                                  JsonlIndex index;
                                  try {
                                      index = sessionchannels::indexFor(services, candidate);
                                  } catch (const std::exception &) {
                                      continue;
                                  }
                                  const historytext::FullText text =
                                      historytext::readMessageFullText(index, messageId, entryId);
                                  if (text.ok) {
                                      return QJsonObject{{QStringLiteral("text"), text.text}};
                                  }
                              }
                              throw ChannelError(sessionchannels::translateOf(services)(
                                  QStringLiteral("session.messageNotFound"), QJsonObject{}));
                          });
                      });

    registry.addAsync(QStringLiteral("sessions:catalog-read-reference-messages"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString sessionId = channels::stringArg(args, 0);
                          sessionchannels::runAsync(responder, [&services, sessionId]() -> QJsonValue {
                              // `readCatalogSessionReferenceMessages` returns [] for drafts; a live
                              // runtime's unflushed session has no file-backed reference list yet.
                              CatalogEntry entry;
                              if (!sessionchannels::findEntry(services, sessionId, &entry)
                                  || !hasSessionFile(entry)) {
                                  return QJsonArray{};
                              }
                              return sessionchannels::scannerOf(services).readReferenceMessages(
                                  requireExistingFile(services, entry.filePath));
                          });
                      });

    registry.addAsync(QStringLiteral("sessions:read-tool-export-payload"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          // Boundary validation first (renderer input is untrusted); the oracle
                          // rejects a non-object input, empty ids and over-long batches.
                          const QJsonValue inputValue = channels::argAt(args, 0);
                          if (!inputValue.isObject()) {
                              responder.reject(QStringLiteral("Invalid tool export payload request"));
                              return;
                          }
                          const QJsonObject input = inputValue.toObject();
                          const QJsonValue sessionIdValue = input.value(QStringLiteral("sessionId"));
                          const QJsonValue messageIdValue = input.value(QStringLiteral("messageId"));
                          if (!sessionIdValue.isString() || sessionIdValue.toString().trimmed().isEmpty()
                              || !messageIdValue.isString()
                              || messageIdValue.toString().trimmed().isEmpty()) {
                              responder.reject(QStringLiteral("Invalid sessionId or messageId"));
                              return;
                          }
                          const QString sessionId = sessionIdValue.toString().trimmed();
                          const QString messageId = messageIdValue.toString().trimmed();
                          sessionchannels::runAsync(responder, [&services, sessionId, messageId]() -> QJsonValue {
                              CatalogEntry entry;
                              const bool known = sessionchannels::findEntry(services, sessionId, &entry);
                              const QString filePath = known && hasSessionFile(entry)
                                  ? entry.filePath
                                  : runtimeSessionFile(services, sessionId);
                              if (filePath.isEmpty()) return QJsonValue(QJsonValue::Null);
                              JsonlIndex index;
                              if (!payloadIndex(services, filePath, &index)) {
                                  return QJsonValue(QJsonValue::Null);
                              }
                              const QHash<QString, historytext::ToolExportPayload> payloads =
                                  historytext::readToolExportPayloads(index, QStringList{messageId});
                              const auto found = payloads.constFind(messageId);
                              if (found == payloads.constEnd()) return QJsonValue(QJsonValue::Null);
                              return QJsonValue(toolPayloadJson(*found));
                          });
                      });

    registry.addAsync(QStringLiteral("sessions:read-tool-export-payloads"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QJsonValue inputValue = channels::argAt(args, 0);
                          if (!inputValue.isObject()) {
                              responder.reject(QStringLiteral("Invalid tool export payloads request"));
                              return;
                          }
                          const QJsonObject input = inputValue.toObject();
                          const QJsonValue sessionIdValue = input.value(QStringLiteral("sessionId"));
                          const QJsonValue idsValue = input.value(QStringLiteral("messageIds"));
                          const QJsonArray ids = idsValue.toArray();
                          bool valid = sessionIdValue.isString()
                              && !sessionIdValue.toString().trimmed().isEmpty() && idsValue.isArray()
                              && !ids.isEmpty() && ids.size() <= kMaxToolPayloadIds;
                          if (valid) {
                              for (const QJsonValue &value : ids) {
                                  if (!value.isString() || value.toString().trimmed().isEmpty()) {
                                      valid = false;
                                      break;
                                  }
                              }
                          }
                          if (!valid) {
                              responder.reject(QStringLiteral("Invalid tool export payloads request"));
                              return;
                          }
                          const QString sessionId = sessionIdValue.toString().trimmed();
                          QStringList messageIds;
                          messageIds.reserve(ids.size());
                          for (const QJsonValue &value : ids) messageIds.append(value.toString().trimmed());
                          sessionchannels::runAsync(responder, [&services, sessionId, messageIds]() -> QJsonValue {
                              CatalogEntry entry;
                              const bool known = sessionchannels::findEntry(services, sessionId, &entry);
                              const QString filePath = known && hasSessionFile(entry)
                                  ? entry.filePath
                                  : runtimeSessionFile(services, sessionId);
                              if (filePath.isEmpty()) return QJsonObject{};
                              JsonlIndex index;
                              if (!payloadIndex(services, filePath, &index)) return QJsonObject{};
                              QJsonObject result;
                              const QHash<QString, historytext::ToolExportPayload> payloads =
                                  historytext::readToolExportPayloads(index, messageIds);
                              for (auto iterator = payloads.constBegin(); iterator != payloads.constEnd();
                                   ++iterator) {
                                  result.insert(iterator.key(), toolPayloadJson(iterator.value()));
                              }
                              return result;
                          });
                      });

    registry.addAsync(QStringLiteral("sessions:catalog-copy"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString sessionId = channels::stringArg(args, 0);
                          CatalogEntry entry;
                          // Oracle copyCatalogSession: a missing record *or* a draft is
                          // `session.fileNotFound` (not the generic "session not found").
                          if (!sessionchannels::findEntry(services, sessionId, &entry)
                              || !hasSessionFile(entry)) {
                              responder.reject(sessionchannels::translateOf(services)(
                                  QStringLiteral("session.fileNotFound"), QJsonObject{}));
                              return;
                          }
                          const QString projectPath =
                              sessionchannels::projectPathOf(services, entry.projectId);
                          // pi owns clone semantics (`… copy` naming, entry rewriting), so the
                          // backend drives a temporary pi session instead of copying bytes; the
                          // new file path only exists after `get_state` (TemporaryPiSession::clone).
                          temporarypi::clone(
                              sessionchannels::settingsObject(services), projectPath, entry.filePath,
                              projectPath, entry.environment,
                              [&services, entry, responder](temporarypi::Result result) mutable {
                                  if (!result.ok) {
                                      responder.reject(result.error);
                                      return;
                                  }
                                  const QString targetPath =
                                      result.data.value(QStringLiteral("sessionPath")).toString();
                                  // pi may cancel the clone (it returns `cancelled:true`), which the
                                  // oracle reports as `{cancelled:true}` — never as an error.
                                  if (result.data.value(QStringLiteral("cancelled")).toBool(false)
                                      || targetPath.isEmpty()) {
                                      responder.resolve(QJsonObject{{QStringLiteral("cancelled"), true}});
                                      return;
                                  }
                                  try {
                                      // The clone is a *new* file: find-or-create its own stable
                                      // UUID record. Touching the source record would repoint the
                                      // original session at the copy (`attachRuntime` semantics),
                                      // which is exactly the oracle's ensureRuntimeTarget split.
                                      const CatalogEntry copied =
                                          sessionchannels::catalogOf(services).ensureRuntimeTarget(
                                              entry.projectId, entry.title, entry.source,
                                              entry.environment, targetPath, entry.wslDistro,
                                              entry.wslUser, entry.importedSourceId, QString());
                                      responder.resolve(QJsonObject{
                                          {QStringLiteral("cancelled"), false},
                                          {QStringLiteral("targetSessionId"), copied.id}});
                                  } catch (const std::exception &failure) {
                                      responder.reject(QString::fromUtf8(failure.what()));
                                  }
                              });
                      });

    registry.addAsync(QStringLiteral("sessions:catalog-export-html"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString sessionId = channels::stringArg(args, 0);
                          CatalogEntry entry;
                          if (!sessionchannels::findEntry(services, sessionId, &entry)
                              || !hasSessionFile(entry)) {
                              responder.reject(sessionchannels::translateOf(services)(
                                  QStringLiteral("session.fileNotFound"), QJsonObject{}));
                              return;
                          }
                          const QString projectPath =
                              sessionchannels::projectPathOf(services, entry.projectId);
                          // pi's `export_html` writes the styled file itself and reports `{path}`;
                          // the oracle forwards that path verbatim (AgentManager.exportSessionHtml).
                          // Re-building the HTML here would invent a different template/name.
                          temporarypi::run(
                              sessionchannels::settingsObject(services), projectPath, entry.filePath,
                              QJsonObject{{QStringLiteral("type"), QStringLiteral("export_html")}},
                              120'000, [responder, &services](temporarypi::Result result) mutable {
                                  if (!result.ok) {
                                      responder.reject(result.error);
                                      return;
                                  }
                                  const QString path =
                                      result.data.value(QStringLiteral("path")).toString();
                                  if (path.isEmpty()) {
                                      responder.reject(sessionchannels::translateOf(services)(
                                          QStringLiteral("session.exportFailed"), QJsonObject{}));
                                      return;
                                  }
                                  responder.resolve(QJsonObject{{QStringLiteral("path"), path}});
                              });
                      });
}
