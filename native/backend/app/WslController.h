#pragma once

#include "WslEnvironment.h"

#include <QJsonObject>
#include <QObject>
#include <QString>

#include <functional>
#include <memory>

class QTimer;
struct ChannelServices;
class SessionCatalogStore;

/**
 * Owner of the *active* WSL environment: resolution, publication and re-publication.
 *
 * Port of the two places the oracle applies WSL state:
 *  - startup (`backendStartupTasks`: resolve once, then switch the scanner / skills /
 *    prompts / extensions / pi config directory), and
 *  - `settings:update` (`systemIpc.ts:667-695`: same switch, plus
 *    `setSessionCatalogIdentityContext`), which the C++ backend used to ignore — the
 *    skill/prompt/extension library kept reading the previous distro until a restart.
 *
 * Two invariants that make the runtime switch safe:
 *  - every write the switch performs for an owner that is *read* on the Qt owner thread —
 *    the scanner's active environment, the skill/prompt manager locations and the pi
 *    config directory — happens on that same thread, in one synchronous block. Those are
 *    plain `QString` / `QVector` values that synchronous channel handlers (`skills:list`,
 *    `prompts:list`, `config:get-models`, the desktop path authorization) read there, so
 *    publishing them from the serial domain executor was a data race and queued the
 *    switch behind unrelated blocking work. The extension manager is the exception: it
 *    is read only from the executor (`extensions:*` bodies), so it is switched there
 *    (`publishExtensionEnvironment`), and the scanner's summary-cache reload follows the
 *    same rule (`summarycache::Cache::reloadFromDisk` is mutex-protected);
 *  - the newest request wins. A probe that is still running when a later `request()`
 *    arrives is discarded (`Resolver::cancel`), its caller is settled immediately, and
 *    the newest request re-probes, so a slow older distro can never overwrite the
 *    settings the user just picked. Only one caller completion is ever alive per request
 *    slot, and it is consumed at the moment it is settled (`finish`), so a late state
 *    assignment can never destroy an already answered responder closure.
 *
 * Scope of the conversion: everything is called on the Qt owner thread. `current()` is
 * only valid there (it is written by the publication).
 */
namespace wslctl {

/**
 * Publish one resolved environment (or the local rollback) to every owner that is read on
 * the Qt owner thread: scanner, skill/prompt manager locations and the pi config
 * directory.
 *
 * Must run on the Qt owner thread: those values are read by synchronous channel handlers
 * there (see the `Controller` invariants). The extension manager is published separately
 * (`publishExtensionEnvironment`), because it is the one owner whose readers all live on
 * the serial domain executor.
 */
void applyEnvironment(ChannelServices &services, const wsl::Environment &environment,
                      const QString &localSessionsDir);

/**
 * Switch the extension manager to `environment`.
 *
 * Runs on the serial domain executor, never on the owner thread: every `extensions:*`
 * body (`list`/`install`/`uninstall`/`toggle`) executes there, so its directory and its
 * cache have exactly one reading thread. Publishing it from the owner instead would race
 * those readers, and guarding it with a lock would let a slow `npm install` body block the
 * WSL switch on the event loop.
 */
void publishExtensionEnvironment(ChannelServices &services, const wsl::Environment &environment);

/**
 * Point the catalog's session-identity builder at the settings' WSL identity.
 *
 * Taken from the *settings* (not from the resolved home) exactly like the oracle: when a
 * distro cannot be resolved the identity still follows the user's choice, while an
 * origin key built from an empty context (`pi:wsl:unknown:unknown:…`) would split one
 * session file into two records on the next scan.
 */
void applyIdentityContext(SessionCatalogStore *catalog, bool enabled, const QString &distro,
                          const QString &user);

class Controller : public QObject {
public:
    struct Deps {
        ChannelServices *services = nullptr;
        /** Local session root, restored when WSL is off or cannot be resolved. */
        QString localSessionsDir;
        /** Structured warning sink (never carries user data beyond distro/user names). */
        std::function<void(const QString &message, const QJsonObject &detail)> warn;
    };

    explicit Controller(Deps deps, QObject *parent = nullptr);
    ~Controller() override;

    /**
     * Resolve and publish one WSL state.
     *
     * `done` runs on the owner thread after the directories are published; it always
     * runs exactly once, including for a request that a newer one supersedes.
     */
    void request(bool enabled, const QString &distro, const QString &user,
                 std::function<void()> done = {});

    /** Currently published environment (invalid when WSL is off/unresolved). */
    const wsl::Environment &current() const { return m_current; }

    /** Kill a probe in flight and drop its callback (shutdown path). Idempotent. */
    void cancel();

private:
    struct Request {
        quint64 sequence = 0;
        bool enabled = false;
        QString distro;
        QString user;
        std::function<void()> done;
    };

    void start(Request request);
    /**
     * Publish `environment` on the owner thread and settle the request inside `m_active`.
     */
    void commit(const wsl::Environment &environment);
    /**
     * Settle a request's completion exactly once.
     *
     * The stored closure is emptied *before* it runs, so the controller never owns (and
     * therefore never destroys) a caller closure while an unrelated channel request is on
     * the stack: the responder closure of an already answered HTTP request can only be
     * destroyed at the point where its own request is settled.
     */
    static void finish(Request &request);
    /** Drop a probe whose result is already superseded (deferred delete: we are inside it). */
    void abandonProbe();
    /** Start the newest queued request once the current one finished. */
    void pump();

    Deps m_deps;
    QString m_localSessionsDir;
    std::unique_ptr<wsl::Resolver> m_resolver;
    /** Newest requested sequence; a probe carrying an older one is superseded. */
    quint64 m_sequence = 0;
    /**
     * Set once a probe continuation was dropped. A `resolver->resolve` callback that was
     * already posted to the owner thread must not publish, restart or answer anything
     * after the controller was cancelled (or destroyed).
     */
    bool m_cancelled = false;
    /** Request whose probe/publication is in flight (empty when idle). */
    bool m_busy = false;
    Request m_active;
    /** Newest request that arrived while `m_busy` (older ones are already settled). */
    Request m_queued;
    wsl::Environment m_current;
};

} // namespace wslctl
