/**
 * Catalog record mutations: rename (catalog-update), archive and delete.
 *
 * Split out of SessionCatalogChannels.cpp because the mutation path is no longer a single
 * blocking body: it crosses the Qt owner thread twice (the runtime tree verdict and the
 * live pi rename) and each crossing needs its own explanation.
 *
 * Oracle contracts (src/main/sessions/SessionRecordService.ts):
 *  - `update()`: a title change of a *running* session goes through
 *    `sessionRuntimeCoordinator.renameRuntime` → `AgentManager.rename` →
 *    `set_session_name`, awaited; `!renamed.ok` throws `mainAgent.renameFailed` and the
 *    catalog is never touched. Only a non-running session renames the JSONL, and only
 *    after `assertTreeIdle` (a running child in the same tree also blocks it).
 *  - `archive()` / `delete()`: `assertTreeIdle` runs before anything is moved.
 *
 * Thread rules (see RuntimeCoordinator.h):
 *  - the tree verdict and the pi rename answer on the Qt owner thread; the answer is
 *    handed back to the serial executor for the filesystem work, so the event loop never
 *    waits on a scan/rename and the runtime maps are never iterated from a worker.
 */
#include "SessionChannelSupport.h"

#include "SessionDeleteChannels.h"
#include "../process/BackgroundWork.h"
#include "../runtime/RuntimeCoordinator.h"
#include "EventHub.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QScopeGuard>

namespace sessionchannels {
namespace {

/** Patch fields the catalog stores directly (`model`, `thinkingLevel`). */
QJsonObject preferencePatch(const QJsonObject &patch)
{
    QJsonObject applied;
    if (patch.contains(QStringLiteral("model"))) {
        applied.insert(QStringLiteral("model"), patch.value(QStringLiteral("model")));
    }
    if (patch.contains(QStringLiteral("thinkingLevel"))) {
        applied.insert(QStringLiteral("thinkingLevel"),
                       patch.value(QStringLiteral("thinkingLevel")));
    }
    return applied;
}

/** Persist the collected patch on the serial executor and answer the renderer. */
void commitUpdate(ChannelServices &services, const QString &sessionId, const QJsonObject &applied,
                  ChannelResponder responder)
{
    background::runBlocking(
        [&services, sessionId, applied]() -> QJsonValue {
            return catalogOf(services).update(sessionId, applied);
        },
        [&services, responder](background::Outcome outcome) mutable {
            if (!outcome.ok) {
                responder.reject(outcome.error);
                return;
            }
            // Only a persisted mutation is announced: a rejected update pushed nothing.
            notifyCatalogRefreshed(
                services, outcome.value.toObject().value(QStringLiteral("projectId")).toString());
            responder.resolve(outcome.value);
        });
}

/** Rewrite the JSONL title for a non-running session, then persist the catalog patch. */
void renameFileThenCommit(ChannelServices &services, const QString &sessionId,
                          const QString &filePath, const QString &title,
                          const QJsonObject &applied, ChannelResponder responder)
{
    QJsonObject withTitle = applied;
    withTitle.insert(QStringLiteral("title"), title);
    if (filePath.isEmpty()) {
        // A draft has no file: there is nothing pi could own, so the catalog is the only
        // place the title lives.
        commitUpdate(services, sessionId, withTitle, responder);
        return;
    }
    runWhenTreeIdle(
        services, sessionId,
        [&services, sessionId, filePath, title, withTitle]() -> QJsonValue {
            const CatalogEntry entry = requireEntry(services, sessionId);
            // The plan crossed the owner thread. Never write its old path and
            // then apply the new title to a record that now owns another file.
            if (entry.filePath != filePath)
                throw ChannelError(translateOf(services)(QStringLiteral("mainAgent.renameFailed"), {}));
            auto &catalog = catalogOf(services);
            if (!catalog.pinDeletion(entry))
                throw ChannelError(translateOf(services)(QStringLiteral("session.deletionInProgress"), {}));
            const auto releasePin = qScopeGuard([&catalog, sessionId] { catalog.releaseDeletion(sessionId); });
            // Rewriting the JSONL while a child agent in the same tree still appends to it
            // would corrupt that child's session, so the guard above is the precondition.
            // Keep the file write and catalog commit in one worker transaction:
            // owner-thread deletion admission cannot take its pin between them.
            scannerOf(services).rename(entry.filePath, title);
            return catalog.update(sessionId, withTitle);
        },
        [&services, responder](background::Outcome outcome) mutable {
            if (!outcome.ok) {
                responder.reject(outcome.error);
                return;
            }
            notifyCatalogRefreshed(
                services, outcome.value.toObject().value(QStringLiteral("projectId")).toString());
            responder.resolve(outcome.value);
        });
}

} // namespace

void registerSessionCatalogMutationChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("sessions:catalog-update"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString sessionId = channels::stringArg(args, 0);
                          const QJsonObject patch = channels::objectArg(args, 1);
                          // Phase 1 (executor): validate and decide what has to change. The
                          // catalog is internally synchronized, so this read is safe here.
                          background::runBlocking(
                              [&services, sessionId, patch]() -> QJsonValue {
                                  const CatalogEntry entry = requireEntry(services, sessionId);
                                  const QString title = patch.value(QStringLiteral("title")).toString().trimmed();
                                  QJsonObject plan;
                                  plan.insert(QStringLiteral("filePath"), entry.filePath);
                                  plan.insert(QStringLiteral("title"),
                                              !title.isEmpty() && title != entry.title ? title : QString());
                                  plan.insert(QStringLiteral("applied"), preferencePatch(patch));
                                  return plan;
                              },
                              [&services, sessionId, responder](background::Outcome outcome) mutable {
                                  if (!outcome.ok) {
                                      responder.reject(outcome.error);
                                      return;
                                  }
                                  const QJsonObject plan = outcome.value.toObject();
                                  const QString title = plan.value(QStringLiteral("title")).toString();
                                  const QJsonObject applied = plan.value(QStringLiteral("applied")).toObject();
                                  if (title.isEmpty()) {
                                      // Model/thinking-only patch: pi must not see a rename.
                                      commitUpdate(services, sessionId, applied, responder);
                                      return;
                                  }
                                  const QString filePath = plan.value(QStringLiteral("filePath")).toString();
                                  if (!services.runtimeCoordinator) {
                                      renameFileThenCommit(services, sessionId, filePath, title, applied,
                                                           responder);
                                      return;
                                  }
                                  // Phase 2 (owner thread): a live runtime owns the file, so the
                                  // title has to land through pi before the catalog records it.
                                  services.runtimeCoordinator->renameRuntimeAsync(
                                      sessionId, title,
                                      [&services, sessionId, filePath, title, applied, responder](
                                          runtime::Coordinator::RenameOutcome result,
                                          const QString &error) mutable {
                                          if (result == runtime::Coordinator::RenameOutcome::Failed) {
                                              responder.reject(error);
                                              return;
                                          }
                                          if (result == runtime::Coordinator::RenameOutcome::Renamed) {
                                              QJsonObject withTitle = applied;
                                              withTitle.insert(QStringLiteral("title"), title);
                                              commitUpdate(services, sessionId, withTitle, responder);
                                              return;
                                          }
                                          // No live runtime: the JSONL fallback.
                                          renameFileThenCommit(services, sessionId, filePath, title,
                                                               applied, responder);
                                      });
                              });
                      });

    registry.addAsync(QStringLiteral("sessions:catalog-archive"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString sessionId = channels::stringArg(args, 0);
                          // Oracle `archive()`: `if (!entry?.filePath) return false` runs
                          // *before* `assertTreeIdle`, so an unknown id or a draft (a record
                          // with no file) is a plain no-op instead of a busy-runtime refusal.
                          CatalogEntry entry;
                          if (!findEntry(services, sessionId, &entry) || entry.filePath.isEmpty()) {
                              responder.resolve(false);
                              return;
                          }
                          const QString projectId = entry.projectId;
                          runWhenTreeIdle(
                              services, sessionId,
                              [&services, sessionId]() -> QJsonValue {
                                  CatalogEntry current;
                                  if (!findEntry(services, sessionId, &current)) return false;
                                  if (current.filePath.isEmpty()) return false;
                                  auto &catalog = catalogOf(services);
                                  // Deletion admission runs on the owner thread while
                                  // archive IO runs here. Claim the shared pin before
                                  // moving files so neither operation can interrupt the
                                  // other's catalog commit after a successful file move.
                                  if (!catalog.pinDeletion(current))
                                      throw ChannelError(translateOf(services)(QStringLiteral("session.deletionInProgress"), {}));
                                  const auto releasePin = qScopeGuard([&catalog, sessionId] { catalog.releaseDeletion(sessionId); });
                                  scannerOf(services).archive(current.filePath);
                                  catalog.removePinned(current);
                                  return true;
                              },
                              [&services, projectId, responder](background::Outcome outcome) mutable {
                                  if (!outcome.ok) {
                                      responder.reject(outcome.error);
                                      return;
                                  }
                                  // A false answer is a no-op, not a mutation: it is not announced.
                                  if (outcome.value.toBool()) {
                                      notifyCatalogRefreshed(services, projectId);
                                  }
                                  responder.resolve(outcome.value);
                              });
                      });

    registerSessionDeleteChannel(registry, services);
}

} // namespace sessionchannels
