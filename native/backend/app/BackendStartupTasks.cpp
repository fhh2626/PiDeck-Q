#include "BackendStartupTasks.h"

#include "ChannelContext.h"
#include "SettingsCatalog.h"
#include "WslController.h"

#include "BackgroundWork.h"
#include "CatalogScanScheduler.h"
#include "EditorDetection.h"
#include "EventHub.h"
#include "ExtensionManager.h"
#include "JsonFile.h"
#include "LegacyBuiltInMigration.h"
#include "PiLaunch.h"
#include "PiSettingsDefaults.h"
#include "ProjectStore.h"
#include "PromptManager.h"
#include "SessionChannelSupport.h"
#include "SessionFs.h"
#include "SessionScanner.h"
#include "SkillManager.h"
#include "AppLogStore.h"
#include "web/WebServiceManager.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QPointer>
#include <QThread>
#include <QTimer>

#include <utility>

namespace {

/** Oracle `ensureRpcTimeoutMinimum`: an accidental 30 s timeout breaks startup. */
constexpr int kRpcTimeoutFloorMs = 600'000;
/** Oracle startup prewarm: one initial delay, then one project per stagger step. */
constexpr int kCatalogPrewarmDelayMs = 3'000;
constexpr int kCatalogPrewarmStaggerMs = 1'500;

} // namespace

BackendStartupTasks::BackendStartupTasks(Deps deps, QObject *parent)
    : QObject(parent), m_deps(std::move(deps))
{
}

BackendStartupTasks::~BackendStartupTasks()
{
    stop();
}

QString BackendStartupTasks::settingsPath() const
{
    return QDir(m_deps.userDataDir).filePath(QStringLiteral("settings.json"));
}

QJsonObject BackendStartupTasks::readSettings() const
{
    return readSettingsCatalog(settingsPath()).settings;
}

void BackendStartupTasks::logInfo(const QString &scope, const QString &message,
                                  const QJsonObject &detail)
{
    if (!m_deps.services || !m_deps.services->appLog) return;
    m_deps.services->appLog->write(QStringLiteral("info"), scope, message, detail);
}

void BackendStartupTasks::logWarn(const QString &scope, const QString &message,
                                  const QJsonObject &detail)
{
    if (!m_deps.services || !m_deps.services->appLog) return;
    m_deps.services->appLog->write(QStringLiteral("warn"), scope, message, detail);
}

QStringList BackendStartupTasks::agentDirs() const
{
    QStringList dirs;
    if (m_deps.services && !m_deps.services->agentDir.isEmpty()) dirs.append(m_deps.services->agentDir);
    const wsl::Environment environment =
        m_deps.services && m_deps.services->wsl ? m_deps.services->wsl->current() : wsl::Environment{};
    if (environment.isValid()) {
        const QString wslAgentDir = QDir(environment.windowsHome).filePath(QStringLiteral(".pi/agent"));
        if (!wslAgentDir.isEmpty() && !dirs.contains(wslAgentDir)) dirs.append(wslAgentDir);
    }
    return dirs;
}

void BackendStartupTasks::start()
{
    if (m_started || !m_deps.services) return;
    m_started = true;

    // 1. Publish the snapshot `createBackend` already loaded. Reloading here would race
    //    an early edit; the renderer only needs the existence notification plus the
    //    environment filter.
    publishStartupProjects();

    // 1b. Apply the persisted LAN web settings exactly once (oracle `applySettings` at
    //     startup). A failure logs a warning and disables the feature in the settings
    //     file instead of blocking startup, so a port that became busy cannot stop the
    //     desktop from opening.
    if (m_deps.services->web) {
        m_deps.services->web->applySettingsAtStartup(readSettings());
    }

    // 2. `rpcTimeout` floor on the next event-loop turn (`setTimeout(..., 0)`).
    m_rpcTimeoutTimer = new QTimer(this);
    m_rpcTimeoutTimer->setSingleShot(true);
    connect(m_rpcTimeoutTimer, &QTimer::timeout, this, [this] { applyRpcTimeoutFloor(); });
    m_rpcTimeoutTimer->start(0);

    // 3. First-launch editor detection does not depend on WSL.
    detectExternalEditors();

    // 4. Resolve WSL exactly once through the shared controller. Four owners depend on it
    //    (scanner, skills, prompts, extensions, pi config), and each extra resolution was
    //    another `wsl.exe printenv HOME` (up to 8 s) with a chance of disagreeing. The
    //    same controller serves `settings:update`, so a distro switch no longer needs a
    //    backend restart.
    const QJsonObject settings = readSettings();
    const QString distro = settings.value(QStringLiteral("wslDistro")).toString();
    const QString user = settings.value(QStringLiteral("wslUser")).toString();
    const bool wslEnabled = settings.value(QStringLiteral("wslEnabled")).toBool(false);
    auto afterEnvironment = [this]() {
        if (m_stopped) return;
        runLegacyMigration();
        ensurePiSettingsDefaultsNow();
        prewarmCatalogScans();
    };
    if (m_deps.services->wsl) {
        m_deps.services->wsl->request(wslEnabled, distro, user, afterEnvironment);
        return;
    }
    // No controller (isolated test wiring): keep the local directories and run the rest.
    afterEnvironment();
}

void BackendStartupTasks::stop()
{
    if (m_stopped) return;
    m_stopped = true;
    if (m_rpcTimeoutTimer) {
        m_rpcTimeoutTimer->stop();
        m_rpcTimeoutTimer->deleteLater();
        m_rpcTimeoutTimer = nullptr;
    }
    for (QTimer *timer : m_prewarmTimers) {
        timer->stop();
        timer->deleteLater();
    }
    m_prewarmTimers.clear();
}

void BackendStartupTasks::publishStartupProjects()
{
    ChannelServices &services = *m_deps.services;
    if (!services.projects) return;
    const QJsonArray visible = services.projects->visibleRecords(readSettings());
    if (services.events) {
        // Wrapping with `QJsonValue` is required: `QJsonArray{visible}` resolves to the copy
        // constructor, which makes the frame args the bare project list. The renderer reads
        // `args[0]`, so the payload must be one argument that *is* the array.
        services.events->broadcast(QStringLiteral("projects:changed"), QJsonArray{QJsonValue(visible)});
    }
}

void BackendStartupTasks::applyRpcTimeoutFloor()
{
    if (m_stopped) return;
    const QJsonObject settings = readSettings();
    const double rpcTimeout = settings.value(QStringLiteral("rpcTimeout")).toDouble();
    if (rpcTimeout >= kRpcTimeoutFloorMs) return;
    updateSettingsCatalog(settingsPath(),
                          QJsonObject{{QStringLiteral("rpcTimeout"), kRpcTimeoutFloorMs}});
    logInfo(QStringLiteral("settings"), QStringLiteral("Raised rpcTimeout to the 600 s floor"),
            QJsonObject{{QStringLiteral("previous"), rpcTimeout}});
}

void BackendStartupTasks::detectExternalEditors()
{
    if (m_editorDetectionStarted) return;
    const QJsonObject current = readSettings().value(QStringLiteral("externalEditors")).toObject();
    for (auto iterator = current.constBegin(); iterator != current.constEnd(); ++iterator) {
        if (!iterator.value().toObject().value(QStringLiteral("command")).toString().isEmpty()) {
            // The user (or a previous launch) already has an editor; detection would only
            // add noise.
            return;
        }
    }
    m_editorDetectionStarted = true;
    auto detected = std::make_shared<QJsonArray>();
    // A dedicated thread, NOT the serial domain executor: a candidate that is not on PATH
    // falls back to a recursive `reg query /s` per candidate, which takes seconds. On the
    // executor that queues every renderer RPC behind a one-time convenience scan (the
    // oracle's async execFile never blocks its loop either). Detection only writes to a
    // heap value, so no shared state is touched off-thread.
    auto *thread = QThread::create([detected] { *detected = editordetect::detectEditors(); });
    thread->setObjectName(QStringLiteral("pideck-editor-detect"));
    connect(thread, &QThread::finished, this, [this, detected] { applyDetectedEditors(*detected); });
    connect(thread, &QThread::finished, thread, &QObject::deleteLater);
    thread->start();
}

void BackendStartupTasks::applyDetectedEditors(const QJsonArray &detected)
{
    if (m_stopped || detected.isEmpty()) return;
    const QJsonObject latest =
        readSettings().value(QStringLiteral("externalEditors")).toObject();
    updateSettingsCatalog(settingsPath(),
                          QJsonObject{{QStringLiteral("externalEditors"),
                                       editordetect::mergeDetectedEditors(latest, detected)}});
    logInfo(QStringLiteral("editor"),
            QStringLiteral("External editors detected on first launch"),
            QJsonObject{{QStringLiteral("count"), detected.size()}});
}

void BackendStartupTasks::runLegacyMigration()
{
    if (m_stopped) return;
    const QStringList dirs = agentDirs();
    const QString version = m_deps.version;
    QPointer<BackendStartupTasks> self(this);
    background::runBlocking(
        [dirs, version]() -> QJsonValue {
            // PiDeck-owned names are safe to remove by name; everything else is only
            // moved after a positive fingerprint match, with a verified backup.
            const legacymigration::StaleOutcome stale = legacymigration::removeStaleEntries(dirs);
            const legacymigration::Outcome outcome = legacymigration::migrate(dirs, version);
            QJsonArray moved;
            for (const legacymigration::Outcome::Moved &entry : outcome.moved) {
                moved.append(QJsonObject{{QStringLiteral("file"), entry.fileName},
                                         {QStringLiteral("fingerprint"), entry.fingerprint},
                                         {QStringLiteral("backup"), entry.backup}});
            }
            QJsonArray preserved;
            for (const legacymigration::Outcome::Preserved &entry : outcome.preserved) {
                preserved.append(QJsonObject{{QStringLiteral("file"), entry.fileName},
                                             {QStringLiteral("path"), entry.path},
                                             {QStringLiteral("reason"), entry.reason}});
            }
            return QJsonValue(QJsonObject{
                {QStringLiteral("removed"), QJsonArray::fromStringList(stale.removed)},
                {QStringLiteral("kept"), QJsonArray::fromStringList(stale.kept)},
                {QStringLiteral("moved"), moved},
                {QStringLiteral("preserved"), preserved},
                {QStringLiteral("warnings"), QJsonArray::fromStringList(outcome.warnings)},
            });
        },
        [self](background::Outcome outcome) {
            if (!self) return;
            const QJsonObject detail = outcome.value.toObject();
            if (!outcome.ok) {
                self->logWarn(QStringLiteral("extension"),
                              QStringLiteral("Failed to migrate legacy built-in extensions"),
                              QJsonObject{{QStringLiteral("error"), outcome.error}});
                return;
            }
            for (const QJsonValue &value : detail.value(QStringLiteral("removed")).toArray()) {
                self->logInfo(QStringLiteral("extension"),
                              QStringLiteral("Removed legacy/stale extension"),
                              QJsonObject{{QStringLiteral("path"), value.toString()}});
            }
            for (const QJsonValue &value : detail.value(QStringLiteral("moved")).toArray()) {
                self->logInfo(QStringLiteral("extension"),
                              QStringLiteral("Backed up legacy built-in extension entry"), value.toObject());
            }
            for (const QJsonValue &value : detail.value(QStringLiteral("warnings")).toArray()) {
                self->logWarn(QStringLiteral("extension"),
                              QStringLiteral("Legacy extension entry left in place"),
                              QJsonObject{{QStringLiteral("detail"), value.toString()}});
            }
        });
}

void BackendStartupTasks::prewarmCatalogScans()
{
    if (m_stopped || !m_deps.services) return;
    ChannelServices &services = *m_deps.services;
    if (!services.projects || !services.catalogScans) return;
    const QJsonArray projects = services.projects->list();
    // Same cadence as the oracle's startup prewarm: one initial delay, then the projects are
    // scanned one after another so a large catalog never competes with the first render.
    for (int index = 0; index < projects.size(); ++index) {
        const QString projectId =
            projects.at(index).toObject().value(QStringLiteral("id")).toString();
        if (projectId.isEmpty()) continue;
        auto *timer = new QTimer(this);
        timer->setSingleShot(true);
        m_prewarmTimers.append(timer);
        connect(timer, &QTimer::timeout, this, [this, timer, projectId] {
            m_prewarmTimers.removeAll(timer);
            timer->deleteLater();
            if (m_stopped || !m_deps.services || !m_deps.services->catalogScans) return;
            m_deps.services->catalogScans->schedule(
                projectId, [this, projectId](std::function<void()> done) {
                    if (m_stopped || !m_deps.services) {
                        done();
                        return;
                    }
                    // The scan itself runs on the domain executor; `done` releases the
                    // scheduler slot so a second trigger merges instead of scanning twice.
                    sessionchannels::refreshCatalogInBackground(*m_deps.services, projectId,
                                                                std::move(done));
                });
        });
        timer->start(kCatalogPrewarmDelayMs + index * kCatalogPrewarmStaggerMs);
    }
}
void BackendStartupTasks::ensurePiSettingsDefaultsNow()
{
    if (m_stopped || !m_deps.services) return;
    const QJsonObject settings = readSettings();
    pilaunch::Request request;
    request.settings = settings;
    request.agentDir = m_deps.services->agentDir;
    request.resourcesDir = m_deps.services->resourcesDir;
    const pilaunch::Launch launch = pilaunch::build(request);
    // Deliberately no probe here. The oracle warms `--version` at startup, but forking pi
    // during startup breaks the "one pi fork per cold model list" contract that the model
    // list parity test pins, and the answer is only a settings hint. Reuse a version that a
    // trust-gated launch (or `pi --version`) already probed in this process.
    const QString version = pilaunch::cachedVersion(launch);
    if (version.isEmpty()) {
        logInfo(QStringLiteral("pi-process"),
                QStringLiteral("Pi version not probed yet; settings defaults run without it"),
                QJsonObject{});
    }
    ensurePiSettingsDefaults(version);
}

void BackendStartupTasks::ensurePiSettingsDefaults(const QString &piVersion)
{
    if (m_stopped) return;
    const QStringList dirs = agentDirs();
    QPointer<BackendStartupTasks> self(this);
    background::runBlocking(
        [dirs, piVersion]() -> QJsonValue {
            QJsonArray updated;
            QJsonArray failed;
            for (const QString &dir : dirs) {
                QString error;
                if (pisettingsdefaults::ensureFor(dir, piVersion, &error)) {
                    updated.append(QDir(dir).filePath(QStringLiteral("settings.json")));
                } else if (!error.isEmpty()) {
                    failed.append(QJsonObject{{QStringLiteral("path"),
                                               QDir(dir).filePath(QStringLiteral("settings.json"))},
                                              {QStringLiteral("error"), error}});
                }
            }
            return QJsonValue(QJsonObject{{QStringLiteral("updated"), updated},
                                          {QStringLiteral("failed"), failed}});
        },
        [self](background::Outcome outcome) {
            if (!self) return;
            const QJsonObject detail = outcome.value.toObject();
            if (!outcome.ok) {
                self->logWarn(QStringLiteral("settings"),
                              QStringLiteral("Failed to ensure pi settings defaults"),
                              QJsonObject{{QStringLiteral("error"), outcome.error}});
                return;
            }
            for (const QJsonValue &value : detail.value(QStringLiteral("updated")).toArray()) {
                self->logInfo(QStringLiteral("settings"),
                              QStringLiteral("Ensured pi settings defaults"),
                              QJsonObject{{QStringLiteral("path"), value.toString()}});
            }
            for (const QJsonValue &value : detail.value(QStringLiteral("failed")).toArray()) {
                self->logWarn(QStringLiteral("settings"),
                              QStringLiteral("Failed to ensure pi settings defaults"),
                              value.toObject());
            }
        });
}
