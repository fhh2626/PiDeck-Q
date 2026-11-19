#include "SessionChannelSupport.h"

#include "SessionIdentity.h"
#include "SummaryReader.h"

#include "../../SessionRuntime.h"
#include "../runtime/RuntimeCoordinator.h"

#include "../../SettingsCatalog.h"

#include "../process/BackgroundWork.h"

#include "AppLogStore.h"
#include "EventHub.h"

#include <QDir>
#include <QJsonValue>

namespace sessionchannels {

SessionCatalogStore &catalogOf(const ChannelServices &services)
{
    if (!services.catalog) throw ChannelError(QStringLiteral("Session catalog is not available"));
    return *services.catalog;
}

SessionScanner &scannerOf(const ChannelServices &services)
{
    if (!services.scanner) throw ChannelError(QStringLiteral("Session scanner is not available"));
    return *services.scanner;
}

QString requireProjectPath(const ChannelServices &services, const QString &projectId)
{
    return channels::resolveProjectPath(services, projectId);
}

QString runtimeProjectPath(const ChannelServices &services, const QString &projectPath)
{
    if (projectPath.isEmpty()) return projectPath;
    const QJsonObject settings = settingsObject(services);
    if (!settings.value(QStringLiteral("wslEnabled")).toBool(false)) return projectPath;
    const QString distro = settings.value(QStringLiteral("wslDistro")).toString();
    if (distro.isEmpty()) return projectPath;
    // `C:\work\app` -> `/mnt/c/work/app`; an already-POSIX path is only normalized.
    return sessionidentity::windowsPathToWslBase(projectPath);
}

QString projectPathOf(const ChannelServices &services, const QString &projectId)
{
    if (projectId.isEmpty()) return QString();
    try {
        return channels::resolveProjectPath(services, projectId);
    } catch (const std::exception &) {
        return QString();
    }
}

QJsonObject settingsObject(const ChannelServices &services)
{
    const QString path = QDir(services.userDataDir).filePath(QStringLiteral("settings.json"));
    return readSettingsCatalog(path).settings;
}

maincopy::Translator translateOf(const ChannelServices &services)
{
    if (services.translate) return services.translate;
    const QString language = channels::settingValue(services, QStringLiteral("language")).toString();
    return maincopy::makeTranslator(language);
}

projector::Deps projectorDeps(const ChannelServices &services)
{
    projector::Deps deps;
    deps.translate = translateOf(services);
    // File-backed history has no live ask state: a cancelled ask is only visible while
    // the runtime is running, which is a runtime-domain concern.
    deps.isAskAborted = [](const QString &) { return false; };
    return deps;
}

JsonlIndex indexFor(const ChannelServices &services, const QString &filePath)
{
    if (!services.indexStore) return jsonlindex::build(filePath);
    return services.indexStore->get(filePath);
}

bool findEntry(const ChannelServices &services, const QString &sessionId, CatalogEntry *out)
{
    return catalogOf(services).get(sessionId, out);
}

CatalogEntry requireEntry(const ChannelServices &services, const QString &sessionId)
{
    CatalogEntry entry;
    if (!findEntry(services, sessionId, &entry)) {
        throw ChannelError(translateOf(services)(QStringLiteral("session.notFound"), QJsonObject{}));
    }
    return entry;
}

bool isSessionBusy(const ChannelServices &services, const QString &sessionId)
{
    // The coordinator owns every session runtime, so the guard must ask it rather than
    // the single-runtime prototype (which only knew about one active session).
    if (services.runtimeCoordinator) return services.runtimeCoordinator->isSessionTreeBusy(sessionId);
    if (!services.runtime) return false;
    if (!services.runtime->active()) return false;
    return services.runtime->sessionId() == sessionId;
}

void querySessionTreeIdle(const ChannelServices &services, const QString &sessionId,
                          std::function<void()> continueOnIdle,
                          std::function<void(const QString &)> onBlocked)
{
    auto report = [&services, sessionId](const QJsonObject &block, std::function<void()> idle,
                                         std::function<void(const QString &)> blocked) {
        if (block.isEmpty()) {
            if (idle) idle();
            return;
        }
        const maincopy::Translator translate = translateOf(services);
        if (block.value(QStringLiteral("kind")).toString() == QLatin1String("file-in-use")) {
            if (blocked) {
                blocked(translate(QStringLiteral("session.inUseDeleteBlocked"),
                                  QJsonObject{{QStringLiteral("title"),
                                               block.value(QStringLiteral("agentTitle"))}}));
            }
            return;
        }
        // Distinguish "stop this session" from "stop the child session": the oracle shows
        // different guidance because the user must act on a different tab.
        if (blocked) {
            blocked(translate(block.value(QStringLiteral("sessionId")).toString() == sessionId
                                  ? QStringLiteral("session.stopBeforeDelete")
                                  : QStringLiteral("session.childRunningDeleteBlocked"),
                              QJsonObject{}));
        }
    };

    if (!services.runtimeCoordinator) {
        // No runtime owner (isolated wiring): only the single-runtime guard can answer.
        QJsonObject block;
        if (isSessionBusy(services, sessionId)) {
            block = QJsonObject{{QStringLiteral("kind"), QStringLiteral("session-busy")},
                                {QStringLiteral("sessionId"), sessionId}};
        }
        report(block, std::move(continueOnIdle), std::move(onBlocked));
        return;
    }
    // The verdict is read on the Qt owner thread; everything after it continues from
    // there, so a caller must hand its blocking work back to the executor.
    services.runtimeCoordinator->sessionTreeBlockAsync(
        sessionId, [report = std::move(report), continueOnIdle = std::move(continueOnIdle),
                    onBlocked = std::move(onBlocked)](const QJsonObject &block) mutable {
            report(block, std::move(continueOnIdle), std::move(onBlocked));
        });
}

void runWhenTreeIdle(const ChannelServices &services, const QString &sessionId,
                    std::function<QJsonValue()> work,
                    std::function<void(background::Outcome)> done)
{
    // The two candidates are built as named locals on purpose: init-captures of *arguments*
    // are initialised in an unspecified order, so `[... done = std::move(done)]` inside both
    // argument lambdas could move `done` into the blocked branch first and hand the idle
    // branch an empty function — the work would run and the caller would never be answered.
    std::function<void(const QString &)> blocked = [done](const QString &message) mutable {
        background::Outcome outcome;
        outcome.ok = false;
        outcome.error = message;
        if (done) done(outcome);
    };
    std::function<void()> idle = [work = std::move(work), done = std::move(done)]() mutable {
        // Back on the serial executor: the guard was answered on the owner thread, the
        // filesystem planning/rename runs where all other blocking domain work runs.
        background::runBlocking(std::move(work), std::move(done));
    };
    querySessionTreeIdle(services, sessionId, std::move(idle), std::move(blocked));
}

QJsonObject summaryJson(const SessionSummary &summary)
{
    // One serializer for the wire shape and the summary cache: a restored cache entry and
    // a freshly scanned session must serialize identically.
    return summaryreader::toJson(summary);
}

QJsonObject pageJson(const historypager::Page &page)
{
    QJsonObject result{
        {QStringLiteral("messages"), page.messages},
        {QStringLiteral("total"), page.total},
        {QStringLiteral("nextBefore"), page.hasNextBefore ? QJsonValue(page.nextBefore)
                                                         : QJsonValue(QJsonValue::Null)},
    };
    if (!page.nextBeforeEntryId.isEmpty()) {
        result.insert(QStringLiteral("nextBeforeEntryId"), page.nextBeforeEntryId);
    }
    if (!page.indexVersion.isEmpty()) result.insert(QStringLiteral("indexVersion"), page.indexVersion);
    return result;
}

void runAsync(ChannelResponder responder, std::function<QJsonValue()> task)
{
    background::runBlocking(std::move(task), [responder](background::Outcome outcome) mutable {
        if (outcome.ok) responder.resolve(outcome.value);
        else responder.reject(outcome.error);
    });
}

QVector<SessionSummary> scanProjectSessions(ChannelServices &services, const QString &projectId)
{
    const QString projectPath = requireProjectPath(services, projectId);
    // In WSL mode the session JSONL records pi's cwd (`/mnt/c/...`), so the membership
    // check must use that form too; the oracle converts the path before calling the
    // scanner, and `scanroots::resolve` maps it back to the host form when it reads
    // project settings.
    const QString runtimePath = runtimeProjectPath(services, projectPath);
    QHash<QString, QString> existingSessionIds;
    for (const CatalogEntry &entry : catalogOf(services).listEntries()) {
        if (entry.projectId != projectId || entry.noSession || entry.filePath.isEmpty()) continue;
        const QString source = entry.source.isEmpty() ? QStringLiteral("pi") : entry.source;
        // Use the record's own namespace. Filling missing WSL identity from the active
        // settings could give a foreign distribution's file this project's membership.
        const QString originKey = sessionidentity::buildSessionOriginKey(
            source, entry.environment, entry.filePath, entry.wslDistro, entry.wslUser,
            source == QLatin1String("codex") ? entry.importedSourceId : QString());
        existingSessionIds.insert(originKey, entry.id);
    }
    return scannerOf(services).list(runtimePath, runtimePath, existingSessionIds);
}

QJsonValue scanAndMerge(ChannelServices &services, const QString &projectId)
{
    const quint64 generation = catalogOf(services).scanGeneration();
    const QVector<SessionSummary> summaries = scanProjectSessions(services, projectId);
    SessionCatalogStore::Context context;
    if (settingsObject(services).value(QStringLiteral("wslEnabled")).toBool(false)) {
        context.wslDistro = settingsObject(services).value(QStringLiteral("wslDistro")).toString();
        context.wslUser = settingsObject(services).value(QStringLiteral("wslUser")).toString();
    }
    return catalogOf(services).mergeScanned(projectId, summaries, context, generation);
}

void notifyCatalogRefreshed(ChannelServices &services, const QString &projectId)
{
    if (projectId.isEmpty() || !services.events) return;
    services.events->broadcast(QStringLiteral("sessions:catalog-refreshed"),
                              QJsonArray{QJsonObject{{QStringLiteral("projectId"), projectId}}});
}

void refreshCatalogInBackground(ChannelServices &services, const QString &projectId,
                               std::function<void()> finished)
{
    background::runBlocking(
        [&services, projectId]() -> QJsonValue { return scanAndMerge(services, projectId); },
        [&services, projectId, finished](background::Outcome outcome) {
            if (!outcome.ok) {
                if (services.appLog) {
                    services.appLog->write(QStringLiteral("warn"), QStringLiteral("session"),
                                           QStringLiteral("Background catalog scan failed"),
                                           QJsonObject{{QStringLiteral("projectId"), projectId},
                                                       {QStringLiteral("error"), outcome.error}});
                }
            } else {
                notifyCatalogRefreshed(services, projectId);
            }
            if (finished) finished();
        });
}

} // namespace sessionchannels
