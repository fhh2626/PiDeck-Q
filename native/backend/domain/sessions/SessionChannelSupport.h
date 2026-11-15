#pragma once

#include "ChannelContext.h"
#include "HistoryPager.h"
#include "JsonlIndex.h"
#include "Projector.h"
#include "SessionCatalogStore.h"
#include "SessionScanner.h"

#include <QJsonArray>
#include <functional>
#include <QJsonObject>
#include <QString>

#include "../process/BackgroundWork.h"

/**
 * Shared plumbing for the session catalog/history channel modules.
 *
 * Every handler resolves its dependencies here instead of reading environment
 * variables or constructing services, so the catalog, scanner and index cache keep a
 * single owner (BackendApplication).
 */
namespace sessionchannels {

SessionCatalogStore &catalogOf(const ChannelServices &services);
SessionScanner &scannerOf(const ChannelServices &services);

/** Project path for a project-scoped channel; throws `Project not found: <id>`. */
QString requireProjectPath(const ChannelServices &services, const QString &projectId);

/**
 * The path pi actually runs with for this project (`sessions:list` / `catalog-list`).
 *
 * In WSL mode a Windows project (`C:\work\app`) is pi's `/mnt/c/work/app`, and that is
 * the `cwd` written into the session JSONL. Scanning with the Windows form would match
 * no WSL session at all, so the conversion happens here — one owner, like the oracle's
 * inline conversion in sessionIpc.
 */
QString runtimeProjectPath(const ChannelServices &services, const QString &projectPath);

/** Raw desktop settings object (pi runtime resolution, offline flags, WSL). */
QJsonObject settingsObject(const ChannelServices &services);

/** Localized copy bound to the current settings language. */
maincopy::Translator translateOf(const ChannelServices &services);

/** Project path for a project id (empty when the project is gone). */
QString projectPathOf(const ChannelServices &services, const QString &projectId);

/** Projector dependencies for file-backed history. */
projector::Deps projectorDeps(const ChannelServices &services);

/** Index for one session file, through the shared LRU cache. */
JsonlIndex indexFor(const ChannelServices &services, const QString &filePath);

/** Catalog entry lookup that throws the localized "session not found" error. */
CatalogEntry requireEntry(const ChannelServices &services, const QString &sessionId);

/** Catalog entry lookup; returns false when the id is unknown. */
bool findEntry(const ChannelServices &services, const QString &sessionId, CatalogEntry *out);

/**
 * True when the session or any session in its tree owns a running runtime.
 * Delete/archive/rename-by-file must refuse while this is true: the running pi process
 * owns the file and would keep writing to a moved path.
 */
bool isSessionBusy(const ChannelServices &services, const QString &sessionId);

/**
 * Resolve the tree-safety verdict on the Qt owner thread, then throw the oracle's error.
 *
 * The verdict inspects the live agent table and the catalog tree, which only the runtime
 * owner thread may touch; the catalog mutation bodies run on the serial executor, so the
 * question has to be handed over instead of answered inline. `continueOnIdle` therefore
 * runs *on the owner thread* and is expected to hand its own blocking work back to the
 * executor (`runWhenTreeIdle`); `onBlocked` receives the localized message.
 *
 * The three copy keys are distinct on purpose (sessionTreeGuard + SessionRecordService):
 *  - a live pi agent appends to a file inside the tree -> `session.inUseDeleteBlocked`
 *    with `{title}` (even without a catalog record for that agent);
 *  - the root itself runs -> `session.stopBeforeDelete`;
 *  - a child runs -> `session.childRunningDeleteBlocked`.
 */
void querySessionTreeIdle(const ChannelServices &services, const QString &sessionId,
                          std::function<void()> continueOnIdle,
                          std::function<void(const QString &)> onBlocked);

/**
 * Run one serial-executor job only after the tree was proven idle on the owner thread.
 *
 * Keeps the destructive filesystem work (`archive`, delete planning) off the Qt loop while
 * the guard itself stays on the thread that owns the runtime state. A blocked tree is
 * reported through `done` with `ok == false`, exactly like a failed job.
 */
void runWhenTreeIdle(const ChannelServices &services, const QString &sessionId,
                    std::function<QJsonValue()> work,
                    std::function<void(background::Outcome)> done);

/** SessionSummary wire form (omits absent optional fields, like the oracle). */
QJsonObject summaryJson(const SessionSummary &summary);

/** Serialize a page for the wire (drops absent optional fields). */
QJsonObject pageJson(const historypager::Page &page);

/**
 * Push `sessions:catalog-refreshed {projectId}` (oracle `notifyCatalogRefreshed`).
 *
 * The renderer keeps its per-project record list from this push, so every path that adds,
 * changes or drops a record must announce it: the catalog mutations (`update` / `archive` /
 * `delete`), the background scan, and a failed anonymous activation that had to remove its
 * transient record. One sender for all of them keeps the frame shape in one place.
 *
 * A no-op for an empty project id or when no event hub is attached (tests, headless runs).
 */
void notifyCatalogRefreshed(ChannelServices &services, const QString &projectId);

/**
 * One scan + merge for a project (runs on the serial domain executor).
 *
 * Shared by the channel's synchronous scan and the startup/background refresh so every
 * path merges identically; `scan:false` never reaches here.
 */
QJsonValue scanAndMerge(ChannelServices &services, const QString &projectId);

/**
 * Scan one project in the background and push `sessions:catalog-refreshed {projectId}`
 * once the merge landed. The renderer answers that push with a `scan:false` pull, so a
 * background scan can never trigger another scan.
 *
 * @param finished called exactly once on the main thread (scan done or failed).
 */
void refreshCatalogInBackground(ChannelServices &services, const QString &projectId,
                               std::function<void()> finished = {});

/** Run blocking work off the event loop and settle the responder exactly once. */
void runAsync(ChannelResponder responder, std::function<QJsonValue()> task);

/**
 * Catalog record mutations (`sessions:catalog-update` / `-archive` / `-delete`).
 *
 * Registered by the catalog module but implemented separately: each of them crosses the Qt
 * owner thread (runtime tree verdict, live pi rename) and so needs its own continuation
 * chain (SessionCatalogMutationChannels.cpp).
 */
void registerSessionCatalogMutationChannels(ChannelRegistry &registry, ChannelServices &services);

} // namespace sessionchannels
