#pragma once

#include "ChannelRegistry.h"
#include "MainCopy.h"
#include "PathPolicy.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>
#include <QStringList>

class ChildProcessRegistry;
class EventHub;
class ExternalFileCapabilities;
class HostRpcClient;
class QuickGenerator;
class SessionCatalogStore;
class SessionRuntime;
class SessionScanner;
class WebServiceManager;
namespace jsonlindex { class Store; }
namespace projects { class Store; class TrustBroker; }
namespace prompts { class Manager; }
namespace skills { class Manager; }
namespace extensions { class Manager; }
namespace xueprompts { class Manager; }
namespace applog { class Store; }
namespace rpclog { class Store; }
namespace usage { class Service; }
namespace runtime { class Coordinator; }
namespace terminal { class Manager; }
namespace appfocus { class Queue; }
namespace catalogscan { class Scheduler; }
namespace wslctl { class Controller; }

/** Mutable cross-channel state owned by the application, not by a handler. */
struct BackendState {
    /** Session the renderer currently focuses (sessions:set-focused-session). */
    QString focusedSessionId;
    /** Session bound to the single runtime instance, when one is active. */
    QString activeSessionId;
    /** Last window state reported by the host; the host remains authoritative. */
    bool windowMaximized = false;
    bool alwaysOnTop = false;
};

/**
 * Services shared by every channel module.
 *
 * Handlers receive this instead of reading environment variables or constructing
 * their own dependencies, so there is exactly one owner for paths, the runtime,
 * the terminal registry, the host bridge and the event hub.
 */
struct ChannelServices {
    QString userDataDir;
    QString sessionsDir;
    QString promptsDir;
    QString skillsDir;
    QString resourcesDir;
    QString backgroundDir;
    /** ~/.pi/agent, part of the desktop file authorization scope. */
    QString agentDir;
    QString appVersion;

    SessionRuntime *runtime = nullptr;
    /** Multi-session pi runtime owner (generation, leases, idempotent sends). */
    runtime::Coordinator *runtimeCoordinator = nullptr;
    /**
     * Pending focus target (notification click / secondary launch). The renderer pulls
     * it on mount and ACKs by id; nothing else may clear it.
     */
    appfocus::Queue *focus = nullptr;
    terminal::Manager *terminals = nullptr;
    HostRpcClient *host = nullptr;
    EventHub *events = nullptr;
    ChildProcessRegistry *children = nullptr;
    BackendState *state = nullptr;
    ExternalFileCapabilities *capabilities = nullptr;
    QuickGenerator *quickGenerator = nullptr;

    /** Durable session catalog (stable UUID identity + session-catalog.json v1). */
    SessionCatalogStore *catalog = nullptr;
    /**
     * The single project catalog owner (projects.json + chat-path.json).
     *
     * Every project-scoped channel resolves through it; it also owns the chat project
     * and the worktree child records, so no other module may read or write the file.
     */
    projects::Store *projects = nullptr;
    /** Project trust decisions (trust.json) and the interactive trust prompt. */
    projects::TrustBroker *trust = nullptr;
    /** Global and project prompt templates (`prompts:*`). */
    prompts::Manager *prompts = nullptr;
    /** Global skills (`skills:*`). */
    skills::Manager *skills = nullptr;
    /** Installed pi extensions (`extensions:*`). */
    extensions::Manager *extensions = nullptr;
    /** Bundled Chinese prompt library (`yao-prompts:*`). */
    xueprompts::Manager *xuePrompts = nullptr;
    /** Application log (`logs:*`, `renderer:log`). */
    applog::Store *appLog = nullptr;
    /** RPC traffic log (`rpc-logs:*`). */
    rpclog::Store *rpcLog = nullptr;
    /** pi-tracker usage analytics (`usage-stats:*`). */
    usage::Service *usageStats = nullptr;
    /**
     * Remote catalogue base URLs (`promptStore`, `skillHub`).
     *
     * Production always uses the built-in defaults; the host may override them so the
     * store channels can be verified against a local stub instead of the live service.
     * The renderer can never influence these values.
     */
    QJsonObject marketEndpoints;
    /** Session file scanner/archive/delete owner. */
    SessionScanner *scanner = nullptr;
    /**
     * Owner of the active WSL environment (`distro`/`user`/home publication).
     *
     * Startup and `settings:update` both go through it so the scanner, the skill/prompt/
     * extension managers, the pi config directory and the catalog identity switch
     * together; a switch that only reached some of them left the app in a mixed state
     * until a restart.
     */
    wslctl::Controller *wsl = nullptr;
    /**
     * Background project-scan coordinator (`sessions:catalog-refreshed`). Null disables
     * the cached+background path, which keeps the channel usable in isolated tests.
     */
    catalogscan::Scheduler *catalogScans = nullptr;
    /** Bounded JSONL index cache shared by every history read. */
    jsonlindex::Store *indexStore = nullptr;
    /** Home directory for the active environment (host home; WSL home is in the scanner). */
    QString hostHome;
    /**
     * pi config directory (`models.json`, `auth.json`, `settings.json`, `trust.json`).
     * Equals `agentDir` until the startup tasks resolve a WSL environment, then points at
     * `<wsl windowsHome>/.pi/agent` so the config UI edits the runtime's real files.
     * Security, vision and usage keep using `agentDir`: the oracle's startup tasks only
     * switch the config/extension/prompt/skill owners.
     *
     * Owner-thread state: it is written only by the WSL controller publication, on the Qt
     * owner thread, which is also the thread every synchronous `config:*` handler reads it
     * on. A body that runs on the serial domain executor must snapshot it before dispatch
     * (`ModelListChannels` does that for `projects:list-models`).
     */
    QString configDir;
    QString downloadsDir;
    /**
     * Test seam for `wsl.exe`: when set, every wsl probe uses this program (resolved
     * through PATH and wrapped when it is a batch shim). Production leaves it empty and
     * the System32 / PATH fallback in `wsl::executable` applies. The renderer can never
     * influence it.
     */
    QString wslExe;
    /** Localized copy for user-visible backend errors. */
    maincopy::Translator translate;
    /**
     * LAN web service owner.
     *
     * `settings:update` / `settings:restart-web-service` reach it through here so the
     * settings domain never has to know about listeners, tokens or ports.
     */
    WebServiceManager *web = nullptr;
};

namespace channels {

/** Bounds-safe argument access; missing arguments yield a null value. */
QJsonValue argAt(const QJsonArray &args, int index);
QString stringArg(const QJsonArray &args, int index);
QJsonObject objectArg(const QJsonArray &args, int index);
/** Numeric argument; a non-numeric value yields 0. */
int intArg(const QJsonArray &args, int index);
QStringList stringListArg(const QJsonArray &args, int index);

/** Convert a domain result into a channel value or throw ChannelError. */
QJsonValue requireOk(bool ok, const QString &error, const QJsonValue &value);

/** `<userData>/projects.json`, the project catalog every scoped channel resolves through. */
QString projectsFile(const ChannelServices &services);

/**
 * Resolve a projectId to its directory. Throws `Project not found: <id>` exactly like
 * the Node oracle so the renderer's error handling is unchanged.
 */
QString resolveProjectPath(const ChannelServices &services, const QString &projectId);

/** The desktop file authorization scope (projects + prompts + skills + agent + userData). */
QStringList authorizedRoots(const ChannelServices &services);

/** Authorize one renderer-supplied path, throwing the oracle's error on rejection. */
QString authorizePath(const ChannelServices &services, const QString &path, const QString &operation,
                      pathpolicy::Mode mode);

/** `maxEditorFileSizeMB` in bytes; the cap every editor-content read honours. */
qint64 maxEditorFileBytes(const ChannelServices &services);

/** Read one settings value; returns a null value when the key is absent. */
QJsonValue settingValue(const ChannelServices &services, const QString &key);

} // namespace channels

void registerAppChannels(ChannelRegistry &registry, ChannelServices &services);
void registerProjectChannels(ChannelRegistry &registry, ChannelServices &services);

/** `projects:list-models` (`pi` model list with thinking-level decoration). */
void registerModelListChannels(ChannelRegistry &registry, ChannelServices &services);

/**
 * Invalidate + re-probe the model list and push `models:changed` on success.
 *
 * Called by `settings:update` when a pi runtime path/preference changes: a different pi
 * binary can expose a different model set, and the composer must not keep rendering the
 * previous one.
 */
void publishModelList(ChannelServices &services);

/** `pi:check`, `pi:check-custom`, `pi:check-npm` and `pi:exec-install`. */
void registerPiInstallChannels(ChannelRegistry &registry, ChannelServices &services);

/** `wsl:list-distros` and `wsl:validate-connection`. */
void registerWslChannels(ChannelRegistry &registry, ChannelServices &services);

/** `settings:get` / `settings:update` and the host window side effects. */
void registerSettingsChannels(ChannelRegistry &registry, ChannelServices &services);

/** `config:*`: pi global configuration files and provider probes. */
void registerConfigChannels(ChannelRegistry &registry, ChannelServices &services);

/** `security:*`: configuration, session overrides and the extension policy snapshot. */
void registerSecurityChannels(ChannelRegistry &registry, ChannelServices &services);

/** `vision:*`: the vision bridge config file and its diagnostics. */
void registerVisionChannels(ChannelRegistry &registry, ChannelServices &services);

/** `scratch-pad:*`: draft markdown files under userData. */
void registerScratchPadChannels(ChannelRegistry &registry, ChannelServices &services);

/** `subagents:*`: the `subagents` block of pi settings.json. */
void registerSubagentChannels(ChannelRegistry &registry, ChannelServices &services);
void registerSessionChannels(ChannelRegistry &registry, ChannelServices &services);

/** `sessions:runtime-*`, prompt dispatch and UI responses. */
void registerRuntimeChannels(ChannelRegistry &registry, ChannelServices &services);

/** session-catalog.json identity, drafts, archive and delete channels. */
void registerSessionCatalogChannels(ChannelRegistry &registry, ChannelServices &services);

/** Paged history, full text, tool export payloads and HTML export channels. */
void registerSessionHistoryChannels(ChannelRegistry &registry, ChannelServices &services);

/** Codex / Claude / OpenCode session import channels. */
void registerSessionImportChannels(ChannelRegistry &registry, ChannelServices &services);
void registerFileChannels(ChannelRegistry &registry, ChannelServices &services);
void registerGitChannels(ChannelRegistry &registry, ChannelServices &services);
void registerTerminalChannels(ChannelRegistry &registry, ChannelServices &services);
void registerStoreChannels(ChannelRegistry &registry, ChannelServices &services);

/** `prompts:*`: global and project prompt templates (create/edit/rename/restore). */
void registerPromptChannels(ChannelRegistry &registry, ChannelServices &services);

/** `skills:*`: discovery, create, toggle, rename, delete and open-folder. */
void registerSkillChannels(ChannelRegistry &registry, ChannelServices &services);

/** `extensions:*`: pi CLI install/remove/update plus the built-in catalogue. */
void registerExtensionChannels(ChannelRegistry &registry, ChannelServices &services);

/** `native:clipboard-snapshot`, `backgrounds:*` and `editors:*` desktop OS capabilities. */
void registerOsChannels(ChannelRegistry &registry, ChannelServices &services);

/** `system:process-metrics` and `system:stop-agent`. */
void registerSystemChannels(ChannelRegistry &registry, ChannelServices &services);

/** `logs:*`, `renderer:log` and `rpc-logs:*`. */
void registerLogChannels(ChannelRegistry &registry, ChannelServices &services);

/** `usage-stats:detect`, `usage-stats:refresh` and `usage-stats:get`. */
void registerUsageChannels(ChannelRegistry &registry, ChannelServices &services);
