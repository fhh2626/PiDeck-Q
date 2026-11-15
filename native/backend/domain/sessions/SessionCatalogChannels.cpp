#include "SessionChannelSupport.h"

#include "CatalogScanScheduler.h"
#include "SessionFiles.h"
#include "SessionIdentity.h"

#include "../../process/BackgroundWork.h"
#include "../runtime/RuntimeCoordinator.h"
#include "EventHub.h"
#include "AppLogStore.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>

namespace {

/** Read one pi config file (`<configDir>/<name>`) as JSON; missing/corrupt yields {}. */
QJsonObject readPiConfig(const QString &configDir, const QString &name)
{
    // `configDir` follows the WSL environment (the oracle reads through ConfigManager), so a
    // WSL draft must not inherit the Windows home defaults. The caller passes a snapshot
    // captured on the Qt owner thread: `settings:update` can republish the directory while
    // this body runs on the serial executor, and a bare shared QString would be a race.
    const QString path = QDir(configDir).filePath(name);
    QString raw;
    QString error;
    if (!sessionfiles::readText(path, &raw, &error)) return QJsonObject{};
    const QJsonDocument document = QJsonDocument::fromJson(raw.toUtf8());
    return document.isObject() ? document.object() : QJsonObject{};
}

struct LaunchDefaults {
    bool hasModel = false;
    QString provider;
    QString modelId;
    bool hasThinking = false;
    QString thinkingLevel;
};

/**
 * Effective default model/thinking for a new draft (port of the auto-fill block in
 * sessionIpc's catalog-create-draft): explicit settings first, then the first provider
 * in models.json. Best effort — draft creation must never fail because config is odd.
 */
LaunchDefaults resolveLaunchDefaults(const QString &configDir)
{
    LaunchDefaults defaults;
    const QJsonObject settings = readPiConfig(configDir, QStringLiteral("settings.json"));
    const QJsonObject models = readPiConfig(configDir, QStringLiteral("models.json"));
    const QString defaultProvider = settings.value(QStringLiteral("defaultProvider")).toString();
    const QString defaultModel = settings.value(QStringLiteral("defaultModel")).toString();
    if (!defaultProvider.isEmpty() && !defaultModel.isEmpty()) {
        defaults.hasModel = true;
        defaults.provider = defaultProvider;
        defaults.modelId = defaultModel;
    } else {
        const QJsonObject providers = models.value(QStringLiteral("providers")).toObject();
        for (auto iterator = providers.constBegin(); iterator != providers.constEnd(); ++iterator) {
            const QJsonArray modelsArray = iterator.value().toObject().value(QStringLiteral("models")).toArray();
            if (modelsArray.isEmpty()) continue;
            const QString id = modelsArray.first().toObject().value(QStringLiteral("id")).toString();
            if (id.isEmpty()) continue;
            defaults.hasModel = true;
            defaults.provider = iterator.key();
            defaults.modelId = id;
            break;
        }
    }
    const QString thinking = settings.value(QStringLiteral("defaultThinkingLevel")).toString();
    if (!thinking.isEmpty()) {
        defaults.hasThinking = true;
        defaults.thinkingLevel = thinking;
    }
    return defaults;
}

QString activeEnvironment(const ChannelServices &services)
{
    return channels::settingValue(services, QStringLiteral("wslEnabled")).toBool(false)
        ? QStringLiteral("wsl")
        : QStringLiteral("native");
}

QJsonObject modelPatch(const QJsonObject &input)
{
    const QJsonValue model = input.value(QStringLiteral("model"));
    if (!model.isObject()) return QJsonObject{};
    const QJsonObject object = model.toObject();
    if (!object.value(QStringLiteral("provider")).isString()
        || !object.value(QStringLiteral("modelId")).isString()) {
        return QJsonObject{};
    }
    return object;
}

QJsonObject thinkingPatch(const QJsonObject &input)
{
    const QJsonValue level = input.value(QStringLiteral("thinkingLevel"));
    if (!level.isString()) return QJsonObject{};
    return QJsonObject{{QStringLiteral("thinkingLevel"), level}};
}

/** Refuse a file-level mutation while any session in the tree is running. */

} // namespace

void registerSessionCatalogChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("sessions:catalog-list"), [&services](const QJsonArray &args,
                                                                           ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QJsonObject options = channels::objectArg(args, 1);
        // `scan:false` is the renderer's refresh path: it must never trigger a scan (that
        // would create a push/pull loop), it only reads the merged catalog cache.
        const bool wantsScan = options.value(QStringLiteral("scan")).toBool(true);
        sessionchannels::runAsync(responder, [&services, projectId, wantsScan]() -> QJsonValue {
            if (!wantsScan) return sessionchannels::catalogOf(services).listProjectRecords(projectId);
            // Every scan request scans. The oracle can answer a warm project from the cache
            // and refresh in the background, but the caller contract here is "a list request
            // returns what is on disk now": the sidebar's poll must not hide a session the
            // user just created, and the background refresh below still keeps the cache warm.
            return sessionchannels::scanAndMerge(services, projectId);
        });
    });
    registry.addAsync(QStringLiteral("sessions:list"), [&services](const QJsonArray &args,
                                                                   ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        sessionchannels::runAsync(responder, [&services, projectId]() -> QJsonValue {
            const QString projectPath = sessionchannels::requireProjectPath(services, projectId);
            const QString runtimeProjectPath = sessionchannels::runtimeProjectPath(services, projectPath);
            const QVector<SessionSummary> summaries =
                sessionchannels::scannerOf(services).list(runtimeProjectPath, runtimeProjectPath);
            QJsonArray result;
            for (const SessionSummary &summary : summaries) {
                result.append(sessionchannels::summaryJson(summary));
            }
            return result;
        });
    });

    registry.addAsync(QStringLiteral("sessions:catalog-create-draft"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QJsonObject input = channels::objectArg(args, 0);
                          // Snapshot the pi config directory on the owner thread; the body below
                          // runs on the serial executor and must not read mutable service state
                          // that a WSL settings change can republish meanwhile.
                          const QString configDir = services.configDir;
                          sessionchannels::runAsync(responder, [&services, input, configDir]() -> QJsonValue {
                              const QString projectId = input.value(QStringLiteral("projectId")).toString();
                              if (projectId.isEmpty()) {
                                  throw ChannelError(QStringLiteral("Invalid projectId"));
                              }
                              sessionchannels::requireProjectPath(services, projectId);
                              const LaunchDefaults defaults = resolveLaunchDefaults(configDir);
                              const QJsonObject model = modelPatch(input);
                              const QJsonObject thinking = thinkingPatch(input);
                              const bool hasModel = !model.isEmpty() || defaults.hasModel;
                              const QString provider = !model.isEmpty()
                                  ? model.value(QStringLiteral("provider")).toString()
                                  : defaults.provider;
                              const QString modelId = !model.isEmpty()
                                  ? model.value(QStringLiteral("modelId")).toString()
                                  : defaults.modelId;
                              const bool hasThinking = !thinking.isEmpty() || defaults.hasThinking;
                              const QString level = !thinking.isEmpty()
                                  ? thinking.value(QStringLiteral("thinkingLevel")).toString()
                                  : defaults.thinkingLevel;
                              QString title = input.value(QStringLiteral("title")).toString().trimmed();
                              if (title.isEmpty()) {
                                  title = sessionchannels::translateOf(services)(
                                      QStringLiteral("session.newTitle"), QJsonObject{});
                              }
                              // A draft is catalog metadata only: no JSONL is written, so
                              // there is no half-initialized file pi would refuse to load.
                              return sessionchannels::catalogOf(services).createDraft(
                                  projectId, title, activeEnvironment(services), QStringLiteral("pi"),
                                  hasModel, provider, modelId, hasThinking, level);
                          });
                      });

    registry.addAsync(QStringLiteral("sessions:create-anonymous"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QJsonObject input = channels::objectArg(args, 0);
                          const QString configDir = services.configDir;
                          // Two phases on purpose: the record is created on the serial executor,
                          // but `sessions:catalog-refreshed` must be pushed from the main thread
                          // (the event hub and its SSE clients are owner-thread state).
                          background::runBlocking(
                              [&services, input, configDir]() -> QJsonValue {
                                  const QString projectId =
                                      input.value(QStringLiteral("projectId")).toString();
                                  if (projectId.isEmpty()) {
                                      throw ChannelError(QStringLiteral("Invalid projectId"));
                                  }
                                  const QString projectPath =
                                      sessionchannels::requireProjectPath(services, projectId);
                                  const LaunchDefaults defaults = resolveLaunchDefaults(configDir);
                                  const QJsonObject model = modelPatch(input);
                                  const QJsonObject thinking = thinkingPatch(input);
                                  QString title = input.value(QStringLiteral("title")).toString().trimmed();
                                  if (title.isEmpty()) {
                                      const QString projectName = QFileInfo(projectPath).fileName();
                                      title = sessionchannels::translateOf(services)(
                                          QStringLiteral("session.anonymousTitle"),
                                          QJsonObject{{QStringLiteral("project"), projectName}});
                                  }
                                  const QJsonObject session =
                                      sessionchannels::catalogOf(services).createAnonymous(
                                          projectId, title, activeEnvironment(services),
                                          !model.isEmpty() || defaults.hasModel,
                                          !model.isEmpty()
                                              ? model.value(QStringLiteral("provider")).toString()
                                              : defaults.provider,
                                          !model.isEmpty()
                                              ? model.value(QStringLiteral("modelId")).toString()
                                              : defaults.modelId,
                                          !thinking.isEmpty() || defaults.hasThinking,
                                          !thinking.isEmpty()
                                              ? thinking.value(QStringLiteral("thinkingLevel")).toString()
                                              : defaults.thinkingLevel);
                                  // `runtime` is optional in CreateAnonymousSessionResult: the
                                  // transient record exists and the runtime start is the runtime
                                  // stage's responsibility.
                                  return QJsonObject{{QStringLiteral("session"), session}};
                              },
                              [&services, responder](background::Outcome outcome) mutable {
                                  if (!outcome.ok) {
                                      responder.reject(outcome.error);
                                      return;
                                  }
                                  // Oracle `createAnonymousSession` pushes the refresh right
                                  // after `createAnonymous`, so the record list picks the new
                                  // transient row up without waiting for the runtime stage.
                                  sessionchannels::notifyCatalogRefreshed(
                                      services,
                                      outcome.value.toObject()
                                          .value(QStringLiteral("session"))
                                          .toObject()
                                          .value(QStringLiteral("projectId"))
                                          .toString());
                                  responder.resolve(outcome.value);
                              });
                      });

    // Rename / archive / delete live in their own module: each of them has to ask the Qt
    // owner thread for the runtime verdict (or the live rename) before the filesystem work.
    sessionchannels::registerSessionCatalogMutationChannels(registry, services);

    registry.addAsync(QStringLiteral("sessions:catalog-unarchive"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString archivedPath = channels::stringArg(args, 0);
                          sessionchannels::runAsync(responder, [&services, archivedPath]() -> QJsonValue {
                              // Boundary validation: an archived path must be a JSONL inside a
                              // `.pideck-archive` directory, otherwise restore could move any
                              // file the renderer names.
                              if (!archivedPath.endsWith(QLatin1String(".jsonl"))) {
                                  throw ChannelError(sessionchannels::translateOf(services)(
                                      QStringLiteral("session.invalidArchivePath"), QJsonObject{}));
                              }
                              const QStringList segments =
                                  archivedPath.split(QRegularExpression(QStringLiteral("[\\\\/]+")));
                              bool insideArchive = false;
                              for (int index = 0; index + 1 < segments.size(); ++index) {
                                  if (segments.at(index) == QLatin1String("pideck-archive")
                                      || segments.at(index) == QLatin1String(".pideck-archive")) {
                                      insideArchive = true;
                                      break;
                                  }
                              }
                              if (!insideArchive) {
                                  throw ChannelError(sessionchannels::translateOf(services)(
                                      QStringLiteral("session.invalidArchivePath"), QJsonObject{}));
                              }
                              sessionchannels::scannerOf(services).unarchive(archivedPath);
                              return true;
                          });
                      });

    registry.addAsync(QStringLiteral("sessions:catalog-list-archived"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
                          sessionchannels::runAsync(responder, [&services]() -> QJsonValue {
                              QJsonArray result;
                              for (const SessionSummary &summary :
                                   sessionchannels::scannerOf(services).listArchived()) {
                                  result.append(sessionchannels::summaryJson(summary));
                              }
                              return result;
                          });
                      });
}
