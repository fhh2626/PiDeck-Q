#include "BackendApplication.h"

#include "BackendStartupTasks.h"
#include "ChannelContext.h"
#include "CatalogScanScheduler.h"
#include "MemoryMonitor.h"
#include "RendererHeartbeat.h"
#include "SettingsCatalog.h"
#include "WindowState.h"
#include "WslController.h"
#include "runtime/PiLaunch.h"
#include "runtime/RuntimeCoordinator.h"
#include "net/DesktopProxy.h"
#include "web/WebServiceManager.h"

#include "BackgroundWork.h"
#include "LiveResyncCoalescer.h"

#include "app/Notifications.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QJsonArray>
#include <QJsonDocument>
#include <QStandardPaths>
#include <QTimer>
#include <QUuid>

#include <optional>
#include <utility>

namespace {

constexpr int kBootstrapClipboardTimeoutMs = 2'000;
constexpr int kLoadRetryDelaysMs[] = {500, 1'000, 2'000};
constexpr int kHeartbeatTickMs = 3'000;
constexpr int kLiveResyncWindowMs = 1'000;
/**
 * Shutdown budgets, sized to fit the host's 1500 ms force-kill window
 * (native/src/BackendProcessController.cpp: m_gracefulStopTimer.start(1500)).
 *
 * The old sequence spent up to 3 s + 1 s per child plus a 250 ms graceful close, so the
 * host killed the backend before `application.readyToExit` and the persisted window
 * bounds were lost on exactly the quits that had a live child.
 */
constexpr int kShutdownChildGraceMs = 500;
constexpr int kShutdownExecutorDrainMs = 250;

QJsonObject fallbackClipboard()
{
    return QJsonObject{
        {QStringLiteral("text"), QString()},
        {QStringLiteral("html"), QString()},
        {QStringLiteral("filePaths"), QJsonArray{}},
        {QStringLiteral("hasImage"), false},
        {QStringLiteral("sequence"), 0},
    };
}

QJsonObject clipboardFromHost(const QJsonValue &value)
{
    if (!value.isObject()) return fallbackClipboard();
    const QJsonObject snapshot = value.toObject();
    QJsonObject clipboard = fallbackClipboard();
    for (auto iterator = snapshot.constBegin(); iterator != snapshot.constEnd(); ++iterator) {
        clipboard.insert(iterator.key(), iterator.value());
    }
    return clipboard;
}

} // namespace

BackendApplication::BackendApplication(BackendEnvironment environment, std::unique_ptr<HostRpcClient> host,
                                       std::unique_ptr<singleinstance::Guard> instance, QObject *parent)
    : QObject(parent), m_environment(std::move(environment)), m_host(std::move(host)),
      m_instance(std::move(instance))
{
    m_services.userDataDir = m_environment.userDataDir;
    m_services.sessionsDir = m_environment.sessionsDir;
    m_services.promptsDir = m_environment.promptsDir;
    m_services.skillsDir = m_environment.skillsDir;
    m_services.resourcesDir = m_environment.resourcesDir;
    m_services.backgroundDir = m_environment.backgroundDir;
    m_services.agentDir = m_environment.agentDir;
    // Until the startup tasks resolve a WSL environment, the pi config directory is the
    // host agent directory; the tasks move it together with the extension/prompt owners.
    m_services.configDir = m_environment.agentDir;
    m_services.appVersion = m_environment.version;
    m_services.runtime = &m_runtime;
    m_services.events = &m_events;
    m_services.children = &m_children;
    m_services.state = &m_state;
    m_services.capabilities = &m_capabilities;
    // The AI commit-message generator reads settings lazily so a settings change is
    // picked up without restarting the backend.
    m_quickGenerator = std::make_unique<QuickGenerator>([this] {
        return readSettingsCatalog(QDir(m_environment.userDataDir).filePath(QStringLiteral("settings.json")))
            .settings;
    });
    m_services.quickGenerator = m_quickGenerator.get();
    m_runtime.setChildRegistry(&m_children);

    // Session catalog/scanner/index wiring. The catalog file lives in userData so a
    // dev and a release build never share UUID identities.
    const QString settingsPath = QDir(m_environment.userDataDir).filePath(QStringLiteral("settings.json"));
    // The PIDECK_HOST_HOME / PIDECK_DOWNLOADS_DIR overrides let tests point the session
    // scanner and the HTML export at a hermetic directory instead of the real profile.
    m_services.hostHome = qEnvironmentVariable("PIDECK_HOST_HOME", QDir::homePath());
    m_services.downloadsDir = qEnvironmentVariable(
        "PIDECK_DOWNLOADS_DIR", QStandardPaths::writableLocation(QStandardPaths::DownloadLocation));
    m_services.translate = maincopy::makeTranslator(
        readSettingsCatalog(settingsPath).settings.value(QStringLiteral("language")).toString());
    // Boot-time proxy application, matching createBackend's startup call: the first
    // outbound request (market search, provider probe, update check) must already obey the
    // persisted desktop proxy settings instead of waiting for a settings:update.
    desktopproxy::apply(readSettingsCatalog(settingsPath, m_services.agentDir).settings);
    // One policy for every outbound QNetworkAccessManager in this process: market
    // catalogues, provider probes and anything added later. Raw sockets used by the
    // proxy probe are deliberately unaffected.
    desktopproxy::installApplicationFactory();

    SessionScanner::Config scannerConfig;
    scannerConfig.hostHome = m_services.hostHome;
    scannerConfig.downloadsDir = m_services.downloadsDir;
    scannerConfig.sessionsDir = m_environment.sessionsDir;
    // The summary cache lives next to the catalog in userData, so a dev and a release
    // build never share parsed history (and switching sidecar kind can reuse it).
    scannerConfig.userDataDir = m_environment.userDataDir;
    // Fixture seams: a WSL timeout test must not spend the production budget on a stalled
    // shim. Defaults stay at the oracle's 18 s scan / 10 s per-command values.
    const int wslScanTimeoutMs = qEnvironmentVariableIntValue("PIDECK_WSL_SCAN_TIMEOUT_MS");
    if (wslScanTimeoutMs > 0) scannerConfig.wslScanTimeoutMs = qBound(500, wslScanTimeoutMs, 120'000);
    const int wslBodyTimeoutMs = qEnvironmentVariableIntValue("PIDECK_WSL_SCAN_BODY_TIMEOUT_MS");
    if (wslBodyTimeoutMs > 0) scannerConfig.wslBodyTimeoutMs = qBound(100, wslBodyTimeoutMs, 60'000);
    m_scanner = std::make_unique<SessionScanner>(scannerConfig, m_services.translate);
    m_services.scanner = m_scanner.get();

    m_indexStore = std::make_unique<jsonlindex::Store>();
    m_services.indexStore = m_indexStore.get();

    // Background project scanning (`sessions:catalog-list` cache-first path + the
    // `sessions:catalog-refreshed` push). Owned here so shutdown can cancel the cooldown.
    m_catalogScans = std::make_unique<catalogscan::Scheduler>(this);
    m_services.catalogScans = m_catalogScans.get();

    SessionCatalogStore::ProjectPathResolver projectPath = [this](const QString &projectId,
                                                                  const QString &) {
        try {
            return channels::resolveProjectPath(m_services, projectId);
        } catch (const std::exception &) {
            return QString();
        }
    };
    m_catalog = std::make_unique<SessionCatalogStore>(
        QDir(m_environment.userDataDir).filePath(QStringLiteral("session-catalog.json")),
        SessionCatalogStore::Context{}, SessionCatalogStore::FilePathResolver{}, projectPath);    try {
        m_catalog->load();
    } catch (const std::exception &failure) {
        // A catalog that cannot be read must not stop the backend: sessions are still
        // usable through the scanner, and the next write repairs the file.
        qWarning("session-catalog: %s", failure.what());
    }
    m_services.catalog = m_catalog.get();

    // Owner of the active WSL environment. Created before the startup tasks and before
    // the channel table, because `settings:update` reaches it through `services.wsl` and
    // the startup tasks kick off the first resolution.
    {
        wslctl::Controller::Deps deps;
        deps.services = &m_services;
        deps.localSessionsDir = m_environment.sessionsDir;
        deps.warn = [this](const QString &message, const QJsonObject &detail) {
            if (!m_services.appLog) return;
            m_services.appLog->write(QStringLiteral("warn"), QStringLiteral("wsl"), message, detail);
        };
        m_wslController = std::make_unique<wslctl::Controller>(std::move(deps), this);
        m_services.wsl = m_wslController.get();
    }

    // Project catalog + trust decisions. The store owns projects.json and
    // chat-path.json; nothing else may read or write them.
    m_projects = std::make_unique<projects::Store>(
        QDir(m_environment.userDataDir).filePath(QStringLiteral("projects.json")),
        QDir(m_environment.userDataDir).filePath(QStringLiteral("chat-path.json")),
        QDir(m_environment.userDataDir).filePath(QStringLiteral("chat-workspace")));
    try {
        // Best effort: an unusable chat directory must not stop the backend from
        // serving the already loaded project records.
        m_projects->load(true);
    } catch (const std::exception &failure) {
        qWarning("projects: %s", failure.what());
    }
    m_services.projects = m_projects.get();
    m_trust = std::make_unique<projects::TrustBroker>(m_environment.agentDir, &m_events);
    m_services.trust = m_trust.get();

    // Store domain: prompt templates, skills, extensions and the bundled prompt library.
    // Each manager is the single owner of its files; the channels only validate input.
    m_prompts = std::make_unique<prompts::Manager>(
        m_environment.promptsDir,
        [this]() {
            QStringList roots;
            try {
                for (const QJsonValue &value : m_projects->list()) {
                    const QJsonObject record = value.toObject();
                    if (record.value(QStringLiteral("kind")).toString() == QLatin1String("chat")) {
                        continue;
                    }
                    const QString path = record.value(QStringLiteral("path")).toString();
                    if (!path.isEmpty()) roots.append(path);
                }
            } catch (const std::exception &) {
                // An unreadable project catalog must not make prompt access impossible.
            }
            return roots;
        },
        prompts::HiddenStore{
            [this, settingsPath]() {
                QStringList names;
                const QJsonArray array = readSettingsCatalog(settingsPath)
                                             .settings.value(QStringLiteral("hiddenBuiltinPromptNames"))
                                             .toArray();
                for (const QJsonValue &value : array) {
                    if (value.isString()) names.append(value.toString());
                }
                return names;
            },
            [this, settingsPath](const QStringList &names) {
                updateSettingsCatalog(settingsPath,
                                      QJsonObject{{QStringLiteral("hiddenBuiltinPromptNames"),
                                                   QJsonArray::fromStringList(names)}});
            },
        },
        m_services.translate);
    m_services.prompts = m_prompts.get();

    m_skills = std::make_unique<skills::Manager>(m_services.hostHome, m_services.translate);
    m_services.skills = m_skills.get();

    m_extensions = std::make_unique<extensions::Manager>(
        m_environment.agentDir,
        [this, settingsPath]() { return readSettingsCatalog(settingsPath).settings; },
        [this, settingsPath](const QJsonObject &patch) { updateSettingsCatalog(settingsPath, patch); },
        m_services.translate);
    m_services.extensions = m_extensions.get();

    m_xuePrompts = std::make_unique<xueprompts::Manager>(
        QDir(m_environment.resourcesDir).filePath(QStringLiteral("xueprompts.db")));
    m_services.xuePrompts = m_xuePrompts.get();
    m_appLog = std::make_unique<applog::Store>(
        QDir(m_environment.userDataDir).filePath(QStringLiteral("logs")));
    m_services.appLog = m_appLog.get();
    m_rpcLog = std::make_unique<rpclog::Store>(
        QDir(m_environment.userDataDir).filePath(QStringLiteral("logs/rpc")));
    m_services.rpcLog = m_rpcLog.get();
    // Live RPC batches: one 80 ms timer coalesces every agent's frames so a streaming turn
    // cannot push one SSE event per pi line (oracle LiveRpcLogBuffer). The interval is
    // env-overridable only so tests can force a burst into a single flush.
    rpclog::LiveBuffer::Deps rpcLogLiveDeps;
    const int rpcLogFlushMs = qEnvironmentVariableIntValue("PIDECK_RPC_LOG_FLUSH_MS");
    if (rpcLogFlushMs > 0) rpcLogLiveDeps.flushMs = qBound(1, rpcLogFlushMs, 60'000);
    rpcLogLiveDeps.deliver = [this](const QJsonObject &batch) {
        m_events.broadcast(QStringLiteral("agents:rpc-log"), QJsonArray{batch});
    };
    m_rpcLogLive = std::make_unique<rpclog::LiveBuffer>(std::move(rpcLogLiveDeps), this);
    m_usageStats = std::make_unique<usage::Service>(
        m_environment.userDataDir, m_environment.agentDir);
    m_services.usageStats = m_usageStats.get();

    m_services.marketEndpoints = QJsonObject{
        {QStringLiteral("promptStore"), qEnvironmentVariable("PIDECK_PROMPT_STORE_BASE")},
        {QStringLiteral("skillHub"), qEnvironmentVariable("PIDECK_SKILL_HUB_BASE")},
    };
    // Fixture seam for the `wsl:*` channels: a test points this at a local stub so no
    // verification ever needs a real distro. Production never sets it.
    m_services.wslExe = qEnvironmentVariable("PIDECK_WSL_EXE");

    // Focus target + notifications: the two owners of "move the user to a session".
    // The target queue is shared by the pull channel, the secondary-launch pipe and the
    // notification click, so only one place can decide that a target was consumed.
    appfocus::Queue::Deps focusDeps;
    focusDeps.requestWindow = [this](const QString &method) { requestWindow(method); };
    focusDeps.broadcast = [this](const QString &channel, const QJsonArray &args) {
        m_events.broadcast(channel, args);
    };
    focusDeps.newId = [] { return QUuid::createUuid().toString(QUuid::WithoutBraces); };
    m_focus = std::make_unique<appfocus::Queue>(std::move(focusDeps), this);
    m_services.focus = m_focus.get();

    appnotifications::Service::Deps notifyDeps;
    notifyDeps.host = m_host.get();
    notifyDeps.focus = m_focus.get();
    notifyDeps.settings = [settingsPath]() { return readSettingsCatalog(settingsPath).settings; };
    notifyDeps.translate = m_services.translate;
    notifyDeps.appName = qEnvironmentVariable("PIDECK_NAME", QStringLiteral("PiDeck-Q"));
    notifyDeps.warn = [this](const QString &scope, const QString &message, const QJsonObject &detail) {
        if (m_appLog) m_appLog->write(QStringLiteral("warn"), scope, message, detail);
    };
    m_notifications = std::make_unique<appnotifications::Service>(std::move(notifyDeps), this);

    // Multi-session pi runtime: the only owner of session processes, bindings,
    // generations, dispatch leases and the idempotent prompt cache.
    runtime::Coordinator::Deps runtimeDeps;
    runtimeDeps.services = &m_services;
    runtimeDeps.settings = [this]() {
        return readSettingsCatalog(QDir(m_environment.userDataDir).filePath(QStringLiteral("settings.json")))
            .settings;
    };
    runtimeDeps.agentDir = m_environment.agentDir;
    runtimeDeps.resourcesDir = m_environment.resourcesDir;
    runtimeDeps.userDataDir = m_environment.userDataDir;
    runtimeDeps.uiLocale = [settingsPath]() {
        // Resolve `system`/`pseudo`/explicit language exactly like the oracle's
        // `currentMainProcessLocale`: built-in extensions only understand `en-US`/`zh-CN`.
        return maincopy::localeTag(maincopy::resolveLocale(readSettingsCatalog(settingsPath).settings));
    };
    // The security gate reads its policy snapshot from this path; the extensions stage
    // owns writing it, so the runtime only forwards it when it exists.
    const QString securitySnapshot =
        QDir(m_environment.userDataDir).filePath(QStringLiteral("security-policy.json"));
    if (QFileInfo::exists(securitySnapshot)) runtimeDeps.securitySnapshotPath = securitySnapshot;
    // The interactive trust prompt is owned by the projects domain; the runtime only
    // asks and records, so one module owns trust.json.
    runtimeDeps.requestTrust = [this](const QString &cwd, const QString &projectName,
                                      std::function<void(const QString &)> done) {
        if (m_trust) m_trust->request(cwd, projectName, std::move(done));
        else done(QStringLiteral("deny"));
    };
    runtimeDeps.rememberTrust = [this](const QString &cwd) {
        if (m_trust) m_trust->setDecision(cwd, true);
    };
    runtimeDeps.respondTrust = [this](const QString &requestId, const QString &choice) {
        if (m_trust) m_trust->respond(requestId, choice);
    };
    // Completion toast: the coordinator already decided this was a real completion, so
    // the notification owner only applies the settings/platform gate (AgentManager's
    // notifySessionEnd does the same split).
    runtimeDeps.notifySessionSettled = [this](const QString &agentId, const QString &sessionTitle,
                                              const QString &sessionId) {
        if (m_notifications) m_notifications->showSessionDone(agentId, sessionTitle, sessionId);
    };
    // Ask reminder for an unfocused session (AgentManager.notifyAskPending): the toast
    // owner applies the setting/platform gate and the per-run dedupe.
    runtimeDeps.notifyAskPending = [this](const QString &agentId, const QString &sessionTitle,
                                          const QString &question, const QString &sessionId) {
        if (m_notifications) {
            m_notifications->showAskPending(agentId, sessionTitle, question, sessionId);
        }
    };
    runtimeDeps.noteRunStarted = [this](const QString &agentId) {
        if (m_notifications) m_notifications->noteRunStarted(agentId);
    };
    // RPC debug panel: the runtime only forwards frames; this side owns the user gate
    // (`rpc-logs:logging-set`), the daily JSONL and the coalesced live batch.
    runtimeDeps.recordRpcLog = [this](const QString &agentId, const QString &direction,
                                      const QJsonObject &data) {
        recordRpcLog(agentId, direction, data);
    };
    runtimeDeps.disposeRpcLog = [this](const QString &agentId) {
        if (m_rpcLog) m_rpcLog->setLoggingEnabled(agentId, false);
        if (m_rpcLogLive) m_rpcLogLive->drop(agentId);
        // A disposed runtime must not leave its ask reminder armed; a fresh agent id is
        // never reused, but the set is otherwise unbounded over a long session day.
        if (m_notifications) m_notifications->forgetAgent(agentId);
    };
    // Deferral primitive for work that must wait out the current signal stack (a pi exit
    // fails its pending RPCs before the exit handler runs). Owned by this QObject so a
    // deferred task can never outlive the event loop the coordinator lives in.
    runtimeDeps.post = [this](std::function<void()> task) {
        QMetaObject::invokeMethod(this, std::move(task), Qt::QueuedConnection);
    };
    m_runtimeCoordinator = std::make_unique<runtime::Coordinator>(std::move(runtimeDeps));
    m_services.runtimeCoordinator = m_runtimeCoordinator.get();

    // Terminal ownership. The manager validates agent targets against the coordinator's
    // binding table and resolves the cwd from the live runtime, so a terminal can never
    // attach to a replaced process or run in another session's directory.
    m_terminals = std::make_unique<terminal::Manager>(
        [this](const QJsonObject &target, QString *error) {
            return m_runtimeCoordinator->validateTarget(target, error);
        },
        [this](const QString &agentId) { return m_runtimeCoordinator->agentCwd(agentId); },
        [this](const QString &channel, const QJsonArray &args) { m_events.broadcast(channel, args); }, this);
    m_services.terminals = m_terminals.get();

    // LAN web listener. Created before the channel table so `settings:update` can reach
    // it; it stays idle until the persisted settings enable it (startup tasks apply them).
    m_webService = std::make_unique<WebServiceManager>(&m_registry, &m_services,
                                                      m_environment.userDataDir,
                                                      m_environment.rendererRoot,
                                                      m_environment.devRendererUrl, this);
    m_services.web = m_webService.get();

    m_lastWindowBounds = windowstate::readLastWindowBounds(m_environment.userDataDir);

    // Renderer recovery thresholds. They are env-overridable so the reload/resync paths can
    // be exercised in seconds instead of the production 15 s window; the renderer can never
    // influence them.
    m_heartbeatWindowMs = qEnvironmentVariableIntValue("PIDECK_RENDERER_HEARTBEAT_WINDOW_MS");
    if (m_heartbeatWindowMs <= 0) m_heartbeatWindowMs = rendererheartbeat::kDefaultWindowMs;
    m_heartbeatTickMs = qEnvironmentVariableIntValue("PIDECK_RENDERER_HEARTBEAT_TICK_MS");
    if (m_heartbeatTickMs <= 0) m_heartbeatTickMs = kHeartbeatTickMs;
    m_liveResyncWindowMs = qEnvironmentVariableIntValue("PIDECK_LIVE_RESYNC_WINDOW_MS");
    if (m_liveResyncWindowMs <= 0) m_liveResyncWindowMs = kLiveResyncWindowMs;

    RendererHttpServer::Options options;
    options.token = m_environment.hostToken;
    options.rendererRoot = m_environment.rendererRoot;
    options.backgroundDirectory = m_environment.backgroundDir;
    m_server = std::make_unique<RendererHttpServer>(&m_registry, &m_events, options, nullptr);
    m_server->setBootstrapProvider([this](std::function<void(const RendererBootstrap &)> respond) {
        provideBootstrap(std::move(respond));
    });
    m_server->setReplayGapHandler([this](const QString &reason, qint64 lostSinceMs, bool hasLostSince) {
        // The reconnecting client already received its `native.resyncRequired` control frame
        // from the server. Broadcasting that frame here would loop: the recovery re-push can
        // itself report another gap. The backend's job is the recovery, not the signal.
        liveresync::Request request;
        request.reason = reason == QLatin1String("oversized-event") ? liveresync::Reason::OversizedEvent
                                                                   : liveresync::Reason::EventHistoryTruncated;
        request.hasLostSinceMs = hasLostSince;
        request.lostSinceMs = lostSinceMs;
        requestLiveResync(request);
    });
    m_server->setHeartbeatObserver([this](const QJsonObject &payload, const EventHub::HeartbeatState &state) {
        if (m_heartbeatWatchdog) m_heartbeatWatchdog->touch();
        const QJsonValue lastSeq = payload.value(QStringLiteral("lastEventSeq"));
        const bool hasSeq = lastSeq.isDouble() && lastSeq.toDouble() >= 0
            && lastSeq.toDouble() == double(qint64(lastSeq.toDouble()));
        const qint64 rendererSeq = hasSeq ? qint64(lastSeq.toDouble()) : 0;
        const rendererheartbeat::RecoveryResult recovery =
            rendererheartbeat::advanceRecovery(m_heartbeatRecovery, hasSeq, rendererSeq, state.healthy);
        m_heartbeatRecovery = recovery.state;
        if (!recovery.shouldResync) return;
        // A stalled cursor is not a dead page: re-push state instead of reloading.
        const qint64 lostSince = m_events.lostSinceMs(
            hasSeq ? quint64(rendererSeq) : 0, hasSeq,
            payload.value(QStringLiteral("eventSourceGeneration")).toString());
        liveresync::Request request;
        request.reason = liveresync::Reason::StalledEventCursor;
        request.hasLostSinceMs = lostSince >= 0;
        request.lostSinceMs = lostSince;
        requestLiveResync(request);
    });
    m_server->setEventChannelDiagnostic([this](const QString &kind, const QJsonObject &detail) {
        if (!m_appLog) return;
        // Transport diagnostics used to be computed and thrown away. Losing data (a killed
        // slow client, a dropped pipelined request, a frame too large to represent) is a
        // warn; a large-but-delivered frame is normal during a long streaming turn (info),
        // so warn would drown it out.
        const bool warn = kind == QLatin1String("client-backpressure-dropped")
            || kind == QLatin1String("pipelined-request-dropped")
            || kind == QLatin1String("oversized-event");
        QJsonObject record = detail;
        record.insert(QStringLiteral("kind"), kind);
        m_appLog->write(warn ? QStringLiteral("warn") : QStringLiteral("info"), QStringLiteral("native"),
                        QStringLiteral("Native event channel diagnostic"), record);
    });

    // Memory profiling: the renderer posts its JS counters here and the monitor merges them
    // with this process's RSS. Off unless PIDECK_MEMORY_PROFILE=1, exactly like the oracle.
    if (m_environment.memoryProfile) {
        memorymonitor::Monitor::Deps deps;
        deps.userDataDir = m_environment.userDataDir;
        deps.intervalMs = m_environment.memoryProfileIntervalMs;
        deps.isStreaming = [this] {
            return m_runtimeCoordinator && m_runtimeCoordinator->hasActiveStreaming();
        };
        m_memoryMonitor = std::make_unique<memorymonitor::Monitor>(std::move(deps), this);
        m_server->setMemoryDiagnosticsSink([this](const QJsonValue &payload) {
            if (m_memoryMonitor && payload.isObject()) m_memoryMonitor->updateRendererDiagnostics(payload.toObject());
        });
    }

    m_liveResync = std::make_unique<liveresync::Coalescer>(this);
    m_liveResync->setWindowMs(m_liveResyncWindowMs);
    m_liveResync->setRun([this](const liveresync::Request &request) { runLiveResync(request); });
    m_liveResync->setOnError([this](const liveresync::Request &request, const QString &error) {
        if (!m_appLog) return;
        m_appLog->write(QStringLiteral("error"), QStringLiteral("native"),
                        QStringLiteral("Renderer state resync failed"),
                        QJsonObject{{QStringLiteral("reason"), liveresync::reasonString(request.reason)},
                                    {QStringLiteral("error"), error}});
    });

    rendererheartbeat::Watchdog::Deps watchdogDeps;
    watchdogDeps.now = [] { return QDateTime::currentMSecsSinceEpoch(); };
    // A tray page may legitimately be idle for minutes; only a visible, non-minimized
    // window is expected to keep its heartbeat timer running.
    watchdogDeps.shouldWatch = [this] {
        return m_focus && m_focus->windowLive() && m_windowVisible && !m_windowMinimized;
    };
    watchdogDeps.reload = [this](std::function<void()> done) {
        if (!m_host) {
            done();
            return;
        }
        auto request = m_host->request(QStringLiteral("window.reload"));
        request->then([done](const QJsonValue &) mutable { done(); });
        request->fail([done](const QString &) mutable { done(); });
    };
    watchdogDeps.onReload = [this] {
        if (!m_appLog) return;
        m_appLog->write(QStringLiteral("warn"), QStringLiteral("native"), QStringLiteral("Renderer reload"),
                        QJsonObject{{QStringLiteral("reason"), QStringLiteral("renderer-heartbeat-timeout")}});
    };
    watchdogDeps.windowMs = m_heartbeatWindowMs;
    m_heartbeatWatchdog = std::make_unique<rendererheartbeat::Watchdog>(watchdogDeps);
    m_heartbeatTimer.setInterval(m_heartbeatTickMs);
    connect(&m_heartbeatTimer, &QTimer::timeout, this, [this] {
        if (m_heartbeatWatchdog) m_heartbeatWatchdog->tick();
    });
    // Renderer load retry. A member timer (not QTimer::singleShot) keeps shutdown able to
    // cancel it: a single-shot still pending when the event loop stops is what made the
    // process linger after quit.
    m_loadRetryTimer.setSingleShot(true);
    connect(&m_loadRetryTimer, &QTimer::timeout, this, [this] {
        if (m_host) m_host->request(QStringLiteral("window.reload"));
    });

    registerChannels();
}

BackendApplication::~BackendApplication()
{
    // Opt-in trace of the teardown phase; member destruction order stays implicit
    // (reverse declaration order) so this destructor cannot change shutdown ordering.
    lifetrace::mark("teardown:enter");
}

void BackendApplication::registerChannels()
{
    registerAppChannels(m_registry, m_services);
    registerProjectChannels(m_registry, m_services);
    registerModelListChannels(m_registry, m_services);
    registerPiInstallChannels(m_registry, m_services);
    registerWslChannels(m_registry, m_services);
    registerSettingsChannels(m_registry, m_services);
    registerConfigChannels(m_registry, m_services);
    registerSecurityChannels(m_registry, m_services);
    registerVisionChannels(m_registry, m_services);
    registerScratchPadChannels(m_registry, m_services);
    registerSubagentChannels(m_registry, m_services);
    registerSessionChannels(m_registry, m_services);
    registerFileChannels(m_registry, m_services);
    registerGitChannels(m_registry, m_services);
    registerTerminalChannels(m_registry, m_services);
    registerStoreChannels(m_registry, m_services);
    registerOsChannels(m_registry, m_services);
    registerSystemChannels(m_registry, m_services);
    registerLogChannels(m_registry, m_services);
    registerUsageChannels(m_registry, m_services);
}

bool BackendApplication::start()
{
    if (!m_host) return false;
    m_services.host = m_host.get();
    wireHostEvents();
    m_host->onFatal([this](const QString &reason) { handleHostFatal(reason); });
    // The listener was bound before the domain services existed (the single-instance
    // decision gates startup), so the payload handler is attached now.
    if (m_instance) {
        m_instance->setOnFocusRequest([this](const appfocus::Payload &payload) { handleFocusRequest(payload); });
    }

    if (!m_server->start()) return false;
    if (m_memoryMonitor) {
        // Started only after the listener exists: a sample implies a serving backend. A
        // failure to create the CSV disables profiling (logged once) instead of failing
        // startup, because the profiler must never gate the product.
        const QString profilePath = m_memoryMonitor->start();
        if (profilePath.isEmpty() && m_appLog) {
            m_appLog->write(QStringLiteral("warn"), QStringLiteral("native"),
                            QStringLiteral("Memory profiler disabled"),
                            QJsonObject{{QStringLiteral("reason"), QStringLiteral("cannot create profile csv")}});
        }
    }
    m_started = true;
    announceRendererReady();
    // Startup tasks run after `renderer.ready` so the window is never delayed by WSL
    // resolution (up to 8 s) or a filesystem migration; everything they publish is pulled
    // by the renderer on mount as well.
    if (!m_startupTasks) {
        BackendStartupTasks::Deps deps;
        deps.services = &m_services;
        deps.userDataDir = m_environment.userDataDir;
        deps.version = m_environment.version;
        deps.localSessionsDir = m_environment.sessionsDir;
        m_startupTasks = std::make_unique<BackendStartupTasks>(std::move(deps), this);
    }
    m_startupTasks->start();
    // A protocol activation can be the reason this process started at all, so the
    // target in this process's own argv is applied after the page exists.
    applyStartupFocus();
    // The watchdog only starts once a page exists to watch.
    m_heartbeatTimer.start();
    return true;
}

void BackendApplication::requestWindow(const QString &method)
{
    if (!m_host) return;
    auto request = m_host->request(method);
    // The window may already be gone (quitting); a failed focus is not actionable.
    request->fail([](const QString &) {});
}

void BackendApplication::handleFocusRequest(const appfocus::Payload &payload)
{
    // A secondary launch is a focus request even when its argv has no session target:
    // restore the window first, then resolve the optional deep link without dropping it.
    requestWindow(QStringLiteral("window.show"));
    requestWindow(QStringLiteral("window.focus"));
    if (!m_focus) return;
    const std::optional<appfocus::Target> target = appfocus::extractFocusTarget(payload.argv);
    if (!target) return;
    if (!target->sessionId.isEmpty()) {
        m_focus->focusSession(target->sessionId, false);
        return;
    }
    // A legacy `pideck://agent/<id>` link only resolves while that runtime is bound: the
    // agent is gone after a restart, and a parked id would never be retried. Report it
    // instead of keeping a target nobody can consume.
    const QString sessionId = m_runtimeCoordinator ? m_runtimeCoordinator->sessionIdForAgent(target->agentId)
                                                   : QString();
    if (sessionId.isEmpty()) {
        if (m_appLog) {
            m_appLog->write(QStringLiteral("warn"), QStringLiteral("native"),
                            QStringLiteral("Focus request target is not bound to a session"),
                            QJsonObject{{QStringLiteral("agentId"), target->agentId},
                                        {QStringLiteral("fromPid"), double(payload.fromPid)}});
        }
        return;
    }
    m_focus->focusSession(sessionId, false);
}

void BackendApplication::applyStartupFocus()
{
    if (!m_focus) return;
    const std::optional<appfocus::Target> target = appfocus::extractFocusTarget(m_environment.hostArgv);
    if (!target) return;
    if (!target->sessionId.isEmpty()) {
        // `showWindow` stays on: this process was started for the notification click, so
        // the window it just created is the destination.
        m_focus->focusSession(target->sessionId);
        return;
    }
    const QString sessionId = m_runtimeCoordinator
        ? m_runtimeCoordinator->sessionIdForAgent(target->agentId)
        : QString();
    if (!sessionId.isEmpty()) m_focus->focusSession(sessionId);
}

QJsonObject BackendApplication::startupSettings() const
{
    const SettingsCatalogRead settings =
        readSettingsCatalog(QDir(m_environment.userDataDir).filePath(QStringLiteral("settings.json")));
    const QJsonObject values = settings.settings;
    return QJsonObject{
        {QStringLiteral("theme"), values.value(QStringLiteral("theme")).toString(QStringLiteral("system"))},
        {QStringLiteral("useNativeTitleBar"), values.value(QStringLiteral("useNativeTitleBar")).toBool(false)},
        {QStringLiteral("closeToTray"), values.value(QStringLiteral("closeToTray")).toBool(true)},
        {QStringLiteral("startupWindowMode"),
         values.value(QStringLiteral("startupWindowMode")).toString(QStringLiteral("last"))},
        {QStringLiteral("lastWindowBounds"),
         m_lastWindowBounds.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(m_lastWindowBounds)},
    };
}

void BackendApplication::announceRendererReady()
{
    if (!m_host) return;
    // The Qt host creates the main window on this event, so it must carry the real
    // listener URL and the token the page uses for its loopback requests.
    m_host->emitEvent(QStringLiteral("renderer.ready"), QJsonObject{
        {QStringLiteral("url"), m_server->url()},
        {QStringLiteral("token"), m_environment.hostToken},
        {QStringLiteral("startup"), startupSettings()},
    });
}

void BackendApplication::provideBootstrap(std::function<void(const RendererBootstrap &)> respond)
{
    RendererBootstrap bootstrap;
    bootstrap.clipboard = fallbackClipboard();
    bootstrap.memoryProfileEnabled = m_environment.memoryProfile;
    const SettingsCatalogRead settings =
        readSettingsCatalog(QDir(m_environment.userDataDir).filePath(QStringLiteral("settings.json")));
    const QJsonValue zoom = settings.settings.value(QStringLiteral("zoomFactor"));
    if (zoom.isDouble() && zoom.toDouble() > 0) bootstrap.zoomFactor = zoom.toDouble();

    auto settled = std::make_shared<bool>(false);
    auto finish = [this, settled, respond](const RendererBootstrap &value) {
        if (*settled) return;
        *settled = true;
        respond(value);
    };

    if (!m_host) return finish(bootstrap);
    // Clipboard reads can block on another application holding the clipboard. The startup
    // handshake must not depend on it, so the request's own deadline rejects it and the
    // degraded snapshot is served.
    //
    // The oracle races its clipboard promise against a timer (`requestWithFallback`). A
    // separate single-shot timer is NOT used here on purpose: a QSingleShotTimer that is
    // still pending when the event loop stops makes process teardown hang after `main`
    // returns (observed: the backend stayed alive and the host had to force-kill it).
    auto request = m_host->request(QStringLiteral("clipboard.metadataSnapshot"), {}, kBootstrapClipboardTimeoutMs);
    request->then([this, finish, bootstrap](const QJsonValue &value) mutable {
        RendererBootstrap next = bootstrap;
        next.clipboard = withClipboardCapability(clipboardFromHost(value));
        finish(next);
    });
    request->fail([finish, bootstrap](const QString &) mutable { finish(bootstrap); });
}

QJsonObject BackendApplication::withClipboardCapability(const QJsonObject &snapshot)
{
    // Clipboard paths are a trusted OS boundary: the renderer receives a capability
    // id it can redeem, never a free-form path it can choose.
    QStringList paths;
    for (const QJsonValue &value : snapshot.value(QStringLiteral("filePaths")).toArray()) {
        if (value.isString()) paths.append(value.toString());
    }
    const int sequence = snapshot.value(QStringLiteral("sequence")).toInt(0);
    QJsonObject result = snapshot;
    result.insert(QStringLiteral("externalFileCapabilityId"), m_capabilities.issueClipboard(paths, sequence));
    return result;
}

void BackendApplication::broadcastHostPayload(const QString &channel, const QJsonObject &payload)
{
    m_events.broadcast(channel, QJsonArray{payload});
}

void BackendApplication::wireHostEvents()
{
    if (!m_host) return;
    m_host->onEvent(QStringLiteral("native.clipboard"), [this](const QJsonValue &payload) {
        broadcastHostPayload(QStringLiteral("native.clipboard"), withClipboardCapability(clipboardFromHost(payload)));
    });
    m_host->onEvent(QStringLiteral("native.fileDrop"), [this](const QJsonValue &payload) {
        // An OS drop is the second trusted boundary; it issues a short-lived capability.
        QJsonObject drop = payload.toObject();
        QStringList paths;
        for (const QJsonValue &value : drop.value(QStringLiteral("paths")).toArray()) {
            if (value.isString()) paths.append(value.toString());
        }
        drop.insert(QStringLiteral("externalFileCapabilityId"), m_capabilities.issueDrop(paths));
        broadcastHostPayload(QStringLiteral("native.fileDrop"), drop);
    });
    m_host->onEvent(QStringLiteral("window.maximizedChanged"), [this](const QJsonValue &payload) {
        const bool maximized = payload.toObject().value(QStringLiteral("maximized")).toBool(payload.toBool());
        m_state.windowMaximized = maximized;
        m_events.broadcast(QStringLiteral("app:window-maximized-changed"), QJsonArray{maximized});
    });
    m_host->onEvent(QStringLiteral("window.normalBoundsChanged"), [this](const QJsonValue &payload) {
        const QJsonObject bounds = payload.toObject();
        if (!bounds.value(QStringLiteral("width")).isDouble() && !bounds.value(QStringLiteral("width")).isString()) return;
        QJsonObject next{
            {QStringLiteral("width"), bounds.value(QStringLiteral("width")).toDouble()},
            {QStringLiteral("height"), bounds.value(QStringLiteral("height")).toDouble()},
        };
        if (bounds.value(QStringLiteral("x")).isDouble() && bounds.value(QStringLiteral("y")).isDouble()) {
            next.insert(QStringLiteral("x"), bounds.value(QStringLiteral("x")).toDouble());
            next.insert(QStringLiteral("y"), bounds.value(QStringLiteral("y")).toDouble());
        } else if (m_lastWindowBounds.contains(QStringLiteral("x"))) {
            next.insert(QStringLiteral("x"), m_lastWindowBounds.value(QStringLiteral("x")));
            next.insert(QStringLiteral("y"), m_lastWindowBounds.value(QStringLiteral("y")));
        }
        m_lastWindowBounds = next;
    });
    m_host->onEvent(QStringLiteral("window.ready"), [this](const QJsonValue &) {
        // A new page: reset every recovery counter so a reload gets a full grace period and
        // the load-failure escalation starts from zero again.
        if (m_focus) m_focus->setWindowLive(true);
        m_windowVisible = true;
        m_loadFailureCount = 0;
        m_loadRetryTimer.stop();
        m_heartbeatRecovery = rendererheartbeat::RecoveryState{};
        if (m_heartbeatWatchdog) m_heartbeatWatchdog->reset();
        // A click that arrived while the window was loading is re-pushed, never consumed:
        // the page may not have subscribed yet and its pull RPC is the reliable path.
        if (m_focus) m_focus->onWindowReady();
    });
    m_host->onEvent(QStringLiteral("window.closed"), [this](const QJsonValue &) {
        if (m_focus) m_focus->setWindowLive(false);
        m_windowVisible = false;
    });
    m_host->onEvent(QStringLiteral("window.visibleChanged"), [this](const QJsonValue &payload) {
        m_windowVisible = payload.toBool();
        // Becoming visible again is a heartbeat: the page was not expected to run its timer
        // while hidden to tray.
        if (m_windowVisible && m_heartbeatWatchdog) m_heartbeatWatchdog->touch();
    });
    m_host->onEvent(QStringLiteral("window.minimizedChanged"), [this](const QJsonValue &payload) {
        m_windowMinimized = payload.toBool();
    });
    m_host->onEvent(QStringLiteral("window.loadFailed"), [this](const QJsonValue &payload) {
        // One retry in flight at a time: repeated loadFailed frames used to arm several
        // timers, so a single page produced a burst of reloads. The timer is a member (not
        // `QTimer::singleShot`) so shutdown can cancel it explicitly.
        if (m_loadRetryTimer.isActive()) return;
        const int delay = m_loadFailureCount < 3 ? kLoadRetryDelaysMs[m_loadFailureCount] : -1;
        if (delay < 0) {
            m_host->request(QStringLiteral("window.showLoadError"), QJsonObject{
                {QStringLiteral("url"), payload.toObject().value(QStringLiteral("url")).toString()},
                {QStringLiteral("error"), payload.toObject().value(QStringLiteral("error")).toString(
                     QStringLiteral("Renderer failed to load"))},
            });
            return;
        }
        ++m_loadFailureCount;
        m_loadRetryTimer.start(delay);
    });
    m_host->onEvent(QStringLiteral("window.loadErrorAction"), [this](const QJsonValue &payload) {
        const QString action = payload.toObject().value(QStringLiteral("action")).toString();
        if (action == QLatin1String("retry") || action == QLatin1String("restart")) {
            m_loadFailureCount = 0;
            m_loadRetryTimer.stop();
            m_host->request(QStringLiteral("window.reload"));
            return;
        }
        if (action == QLatin1String("exit")) m_host->request(QStringLiteral("application.quit"));
    });
    m_host->onEvent(QStringLiteral("application.prepareQuit"), [this](const QJsonValue &) { handlePrepareQuit(); });
    m_host->onEvent(QStringLiteral("application.quit"), [this](const QJsonValue &) { handlePrepareQuit(); });
    m_host->onEvent(QStringLiteral("application.focusTarget"), [this](const QJsonValue &payload) {
        // The host only reports a target it has already surfaced (a protocol activation
        // it handled itself), so no window request is issued here.
        const QString sessionId = payload.toObject().value(QStringLiteral("sessionId")).toString();
        if (m_focus && !sessionId.isEmpty()) m_focus->setPendingTarget(sessionId);
    });
}

void BackendApplication::requestLiveResync(const liveresync::Request &request)
{
    if (!m_liveResync) return;
    m_liveResync->request(request);
}

void BackendApplication::runLiveResync(const liveresync::Request &request)
{
    Q_UNUSED(request);
    // Full state, not a signal: the renderer deliberately ignores `native.resyncRequired`
    // object payloads (it must not navigate on a transport hiccup), so only a real re-push
    // repairs a truncated event history.
    if (m_runtimeCoordinator) {
        m_runtimeCoordinator->resyncLiveState();
        return;
    }
    m_events.broadcast(QStringLiteral("agents:state"), QJsonArray{QJsonValue(QJsonArray{})});
}

void BackendApplication::handleHostFatal(const QString &reason)
{
    Q_UNUSED(reason);
    // The host owns window, tray and quit. Without it there is nothing to serve, so
    // clean up within a bounded window and exit so the supervisor can recover.
    // Queued (not `QTimer::singleShot(0)`) so no timer can outlive the event loop.
    QMetaObject::invokeMethod(
        this,
        [this] {
            shutdown();
            QCoreApplication::exit(1);
        },
        Qt::QueuedConnection);
}

void BackendApplication::handlePrepareQuit()
{
    if (m_shutdownStarted) return;
    lifetrace::mark("quit:begin");
    shutdown();
    QCoreApplication::quit();
    lifetrace::mark("quit:requested");
}

void BackendApplication::recordRpcLog(const QString &agentId, const QString &direction,
                                      const QJsonObject &data)
{
    if (!m_rpcLog || agentId.isEmpty()) return;
    // The gate is per runtime and user-controlled: recording is off by default, exactly
    // like `AgentManager.rpcLoggingAgents`.
    if (!m_rpcLog->loggingEnabled(agentId)) return;
    const QJsonObject entry = rpclog::makeEntry(agentId, direction, data,
                                                QDateTime::currentMSecsSinceEpoch(),
                                                rpclog::newEntryId());
    // Disk row + bounded in-memory ring (the ring summarizes a >4 KiB `data`, the file
    // keeps the frame verbatim except the 200-character bash command).
    m_rpcLog->push(entry);
    // The live batch carries the full record: the renderer's expansion needs the data, and
    // only `rpc-logs:get-live` is capped.
    if (m_rpcLogLive) m_rpcLogLive->enqueue(entry);
}

void BackendApplication::shutdown()
{
    if (m_shutdownStarted) return;
    m_shutdownStarted = true;
    lifetrace::mark("shutdown:enter");

    // 0. Stop the recovery timers first: a reload or re-push scheduled during teardown would
    //    touch services that are about to go away.
    m_heartbeatTimer.stop();
    m_loadRetryTimer.stop();
    // No RPC log batch may reach the event channel after the renderer was told to exit.
    if (m_rpcLogLive) m_rpcLogLive->clear();
    // The startup tasks own a WSL probe child process and a cooldown timer; both attach to
    // the services that step 3/4 tear down, so they stop before anything else.
    if (m_startupTasks) m_startupTasks->stop();
    // The WSL controller owns the probe child process; cancel it before the services it
    // reads (scanner/managers/config) are torn down.
    if (m_wslController) m_wslController->cancel();
    if (m_catalogScans) m_catalogScans->dispose();
    if (m_liveResync) m_liveResync->dispose();
    if (m_memoryMonitor) m_memoryMonitor->stop();

    // 1. Persist runtime-only window state before anything can block. The host force-kills
    //    this process 1500 ms after prepareQuit, so the cheap must-not-be-lost work goes
    //    first instead of last (it used to run after a multi-second child teardown).
    windowstate::saveLastWindowBounds(m_environment.userDataDir, m_lastWindowBounds);

    // 2. Stop accepting new work before tearing anything down.
    if (m_server) m_server->stop();
    // The LAN listener belongs to the user's network; it is closed before any domain
    // service goes away so no in-flight request can touch a half-destroyed manager.
    if (m_webService) m_webService->shutdown();
    // 3. Stop the auxiliary pi process and every other child; pi may still own a session
    //    file, so it gets a bounded grace period instead of being killed mid-write.
    if (m_quickGenerator) m_quickGenerator->dispose();
    if (m_runtimeCoordinator) m_runtimeCoordinator->shutdown();
    m_runtime.stop();
    if (m_terminals) m_terminals->closeAll();
    m_children.stopAll(kShutdownChildGraceMs);
    lifetrace::mark("shutdown:children-stopped");
    // 3c. Persist the scan summary cache before the executor stops: the map is derived data,
    //     but writing it now is what makes the next launch's first list cheap. The write is
    //     synchronous here because no executor continuation is guaranteed after step 4.
    if (m_scanner) m_scanner->flushSummaryCache();
    lifetrace::mark("shutdown:cache-flushed");
    // 4. Quiesce the serial domain executor: it refuses new work, discards the bodies that are
    //    still queued, and lets the body in flight finish inside the budget. A body that
    //    finishes from here on drops its completion instead of posting it (the event loop is
    //    about to stop, and the completion would otherwise be destroyed after teardown — which
    //    is what used to hang the process), and a body that outlives the budget makes the
    //    caller abandon the executor and exit without destructors. This must stay before the
    //    ACK: the host force-kills 1500 ms after prepareQuit.
    const bool drained = background::drainAndStop(kShutdownExecutorDrainMs);
    lifetrace::mark(drained ? "shutdown:executor-drained" : "shutdown:executor-abandoned");
    // 5. Revoke every external file capability: nothing may be readable after quit.
    m_capabilities.clear();
    // 6. Release the version lock before the host can start a replacement instance:
    //    the replacement would otherwise see a live endpoint and exit as secondary.
    if (m_instance) {
        m_instance->dispose();
        m_instance.reset();
    }
    lifetrace::mark("shutdown:lock-released");
    // 7. ACK only after cleanup so the host's post-ACK kill is a no-op.
    if (m_host) {
        m_host->emitEvent(QStringLiteral("application.readyToExit"), QJsonObject{});
        m_host->closeGracefully(250);
    }
    lifetrace::mark("shutdown:acked");
}
