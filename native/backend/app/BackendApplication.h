#pragma once

#include "BackendEnvironment.h"
#include "ChannelContext.h"
#include "ChildProcessRegistry.h"
#include "EventHub.h"
#include "ExternalFileCapabilities.h"
#include "HostRpcClient.h"
#include "LifecycleTrace.h"
#include "QuickGenerator.h"
#include "RendererHeartbeat.h"
#include "RendererHttpServer.h"
#include "SessionRuntime.h"
#include "app/FocusTargets.h"
#include "app/SingleInstance.h"
#include "app/WslController.h"
#include "sessions/JsonlIndex.h"
#include "sessions/SessionCatalogStore.h"
#include "sessions/SessionScanner.h"
#include "projects/ProjectStore.h"
#include "projects/TrustBroker.h"
#include "terminal/TerminalManager.h"
#include "extensions/ExtensionManager.h"
#include "logs/AppLogStore.h"
#include "logs/RpcLogEntry.h"
#include "logs/RpcLogLive.h"
#include "logs/RpcLogStore.h"
#include "market/XuePrompts.h"
#include "prompts/PromptManager.h"
#include "skills/SkillManager.h"
#include "usage/UsageService.h"

#include <QJsonObject>
#include <QObject>
#include <QTimer>

#include <memory>

namespace runtime { class Coordinator; }
namespace liveresync { class Coalescer; struct Request; }
namespace memorymonitor { class Monitor; }
namespace appnotifications { class Service; }
class BackendStartupTasks;
class WebServiceManager;
namespace catalogscan { class Scheduler; }

/**
 * Backend wiring and lifecycle.
 *
 * This class only assembles services and owns the shutdown ordering; every domain
 * behaviour lives in a channel module under domain/. Start order matters:
 *   1. host handshake (nothing else works without the bridge),
 *   2. renderer HTTP listener,
 *   3. renderer.ready (the Qt host creates the window on this event),
 *   4. accept RPC/SSE traffic.
 * Shutdown is the exact reverse and ACKs the host only after children are gone.
 */
class BackendApplication : public QObject {

public:
    /**
     * @param host       already connected host bridge; the backend does not own the
     *                   handshake because the single-instance decision must happen first.
     * @param instance   version lock when this process is the primary; null when the
     *                   single-instance preference is off.
     */
    BackendApplication(BackendEnvironment environment, std::unique_ptr<HostRpcClient> host,
                       std::unique_ptr<singleinstance::Guard> instance, QObject *parent = nullptr);
    ~BackendApplication() override;

    /** Connect, listen, announce. Returns false when startup cannot continue. */
    bool start();
    /** Run the shutdown sequence. Idempotent. */
    void shutdown();

private:
    void registerChannels();
    void wireHostEvents();
    /**
     * One pi RPC frame: apply the per-agent recording gate, append to the daily JSONL and
     * queue the ~80 ms `agents:rpc-log` batch (oracle `AgentManager` rpc-log handler).
     */
    void recordRpcLog(const QString &agentId, const QString &direction, const QJsonObject &data);
    /** Fire-and-forget host window call (`window.show` / `window.focus`). */
    void requestWindow(const QString &method);
    /** A secondary launch forwarded its argv: restore the window, then queue the target. */
    void handleFocusRequest(const appfocus::Payload &payload);
    /** Focus the session this process was started for (protocol activation). */
    void applyStartupFocus();
    void provideBootstrap(std::function<void(const RendererBootstrap &)> respond);
    void announceRendererReady();
    void handlePrepareQuit();
    void handleHostFatal(const QString &reason);
    void broadcastHostPayload(const QString &channel, const QJsonObject &payload);
    /** Queue a full renderer state re-push (coalesced per window). */
    void requestLiveResync(const liveresync::Request &request);
    /** Re-push `agents:state` plus every bound agent's message window. */
    void runLiveResync(const liveresync::Request &request);
    /** Issue a clipboard capability and attach it to a snapshot payload. */
    QJsonObject withClipboardCapability(const QJsonObject &snapshot);
    QJsonObject startupSettings() const;

    /**
     * Opt-in teardown boundary marker (`PIDECK_LIFECYCLE_TRACE`).
     *
     * Members are destroyed in reverse declaration order, so a probe declared *before* a
     * member is destroyed *after* it. That makes the trace name the last service that was
     * torn down when a destructor blocks, which a hung-process stack could not give us
     * here (no debugger on this machine). No behaviour change: no-op when tracing is off.
     */
    struct TraceBoundary {
        const char *phase;
        ~TraceBoundary() { lifetrace::mark(phase); }
    };

    /** Declared first, so this mark fires after every other member is gone. */
    TraceBoundary m_traceMembersGone{"teardown:members-destroyed"};

    BackendEnvironment m_environment;
    std::unique_ptr<HostRpcClient> m_host;
    /** Version lock; released during shutdown before the host may restart a sidecar. */
    std::unique_ptr<singleinstance::Guard> m_instance;
    /** Pending focus target: notification click, secondary launch or activation URL. */
    std::unique_ptr<appfocus::Queue> m_focus;
    /** Completion toast producer and the four host event routes. */
    std::unique_ptr<appnotifications::Service> m_notifications;
    EventHub m_events;
    ChannelRegistry m_registry;
    ChannelServices m_services;
    BackendState m_state;
    SessionRuntime m_runtime;
    /** Terminal owner: PTY processes, ownership buckets and bounded replay buffers. */
    std::unique_ptr<terminal::Manager> m_terminals;
    ChildProcessRegistry m_children;
    ExternalFileCapabilities m_capabilities;
    /**
     * Session catalog, scanner and index cache.
     * The catalog is the UUID identity owner; the scanner owns every file-level
     * mutation; the index cache is shared so paged reads never re-index a file.
     */
    std::unique_ptr<SessionCatalogStore> m_catalog;
    /** Owner of the active WSL environment (startup + `settings:update`). */
    std::unique_ptr<wslctl::Controller> m_wslController;
    std::unique_ptr<SessionScanner> m_scanner;
    /** Cooldown/dedupe owner for background catalog scans. */
    std::unique_ptr<catalogscan::Scheduler> m_catalogScans;
    /** One-shot startup work: WSL resolution, legacy migration, defaults, version warm-up. */
    std::unique_ptr<BackendStartupTasks> m_startupTasks;
    /** LAN web listener owner: the only place that decides whether it is serving. */
    std::unique_ptr<WebServiceManager> m_webService;
    std::unique_ptr<jsonlindex::Store> m_indexStore;
    std::unique_ptr<QuickGenerator> m_quickGenerator;
    /** Project catalog owner (projects.json + chat-path.json). */
    std::unique_ptr<projects::Store> m_projects;
    /** Project trust decisions and the interactive trust prompt. */
    std::unique_ptr<projects::TrustBroker> m_trust;
    /** Session runtime owner: pi processes, bindings, generations, leases. */
    std::unique_ptr<runtime::Coordinator> m_runtimeCoordinator;
    /**
     * Store-domain owners: prompt templates, skills, extensions and the bundled
     * Chinese prompt library. Each is the single writer of its own files.
     */
    std::unique_ptr<prompts::Manager> m_prompts;
    std::unique_ptr<skills::Manager> m_skills;
    std::unique_ptr<extensions::Manager> m_extensions;
    std::unique_ptr<xueprompts::Manager> m_xuePrompts;
    /** Application and RPC traffic logs. */
    std::unique_ptr<applog::Store> m_appLog;
    std::unique_ptr<rpclog::Store> m_rpcLog;
    std::unique_ptr<rpclog::LiveBuffer> m_rpcLogLive;
    std::unique_ptr<usage::Service> m_usageStats;
    std::unique_ptr<RendererHttpServer> m_server;
    /**
     * Renderer recovery: the heartbeat watchdog reloads a page whose timers stopped, and
     * the coalescer re-pushes full state after an event-stream gap. Both are owned here so
     * there is exactly one recovery path for the whole process.
     */
    std::unique_ptr<rendererheartbeat::Watchdog> m_heartbeatWatchdog;
    rendererheartbeat::RecoveryState m_heartbeatRecovery;
    std::unique_ptr<liveresync::Coalescer> m_liveResync;
    /** `PIDECK_MEMORY_PROFILE=1` CSV sampler; null when profiling is off. */
    std::unique_ptr<memorymonitor::Monitor> m_memoryMonitor;
    QTimer m_heartbeatTimer;
    /** Renderer load retry (member timer so shutdown can cancel it). */
    QTimer m_loadRetryTimer;
    int m_heartbeatWindowMs = 0;
    int m_heartbeatTickMs = 0;
    int m_liveResyncWindowMs = 0;
    /** Window visibility as reported by the host; the host remains authoritative. */
    bool m_windowVisible = false;
    bool m_windowMinimized = false;
    QJsonObject m_lastWindowBounds;
    int m_loadFailureCount = 0;
    bool m_started = false;
    bool m_shutdownStarted = false;
};
