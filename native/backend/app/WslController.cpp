#include "WslController.h"

#include "BackgroundWork.h"
#include "ChannelContext.h"
#include "ExtensionManager.h"
#include "PromptManager.h"
#include "SessionCatalogStore.h"
#include "SessionFs.h"
#include "SessionScanner.h"
#include "SkillManager.h"
#include "logs/AppLogStore.h"

#include <QDir>
#include <QJsonValue>
#include <QPointer>

#include <memory>
#include <utility>

namespace wslctl {

void applyEnvironment(ChannelServices &services, const wsl::Environment &environment,
                      const QString &localSessionsDir)
{
    const bool useWsl = environment.isValid();
    if (useWsl) {
        SessionFs::Config fs;
        fs.wsl = true;
        fs.distro = environment.distro;
        fs.user = environment.user;
        fs.home = environment.linuxHome;
        // The fixture seam has to reach the scanner too, otherwise a WSL scan test would
        // spawn the real wsl.exe.
        fs.executable = services.wslExe;
        if (services.scanner) {
            services.scanner->configureEnvironment(
                fs, environment.linuxHome + QStringLiteral("/.pi/agent/sessions"));
        }
        if (services.skills) services.skills->configureWsl(&environment);
        if (services.prompts) services.prompts->configureWsl(&environment);
        // The extension manager is switched on the executor (see
        // `publishExtensionEnvironment`), not here.
        // pi's models.json/auth.json/settings.json (and the thinking-level map derived
        // from models.json) live in the WSL home once WSL is the active runtime.
        services.configDir = QDir(environment.windowsHome).filePath(QStringLiteral(".pi/agent"));
        return;
    }
    if (services.scanner) {
        services.scanner->configureEnvironment(SessionFs::Config{}, localSessionsDir);
    }
    if (services.skills) services.skills->configureWsl(nullptr);
    if (services.prompts) services.prompts->configureWsl(nullptr);
    services.configDir = services.agentDir;
}

void publishExtensionEnvironment(ChannelServices &services, const wsl::Environment &environment)
{
    if (!services.extensions) return;
    // The `Environment` stays alive until the body ran: the manager takes a pointer and
    // copies what it needs, and a reference into the caller's stack would be gone by then.
    auto published = std::make_shared<wsl::Environment>(environment);
    background::runBlocking(
        [&services, published]() -> QJsonValue {
            services.extensions->configureWsl(published->isValid() ? published.get() : nullptr);
            return QJsonValue();
        },
        [](background::Outcome) {});
}

void applyIdentityContext(SessionCatalogStore *catalog, bool enabled, const QString &distro,
                          const QString &user)
{
    if (!catalog) return;
    SessionCatalogStore::Context context;
    if (enabled) {
        // Settings, not the resolved home: the identity has to stay stable even when the
        // distro cannot be probed (the fallback home is a runtime detail).
        context.wslDistro = distro;
        context.wslUser = user;
    }
    catalog->setIdentityContext(context);
}

Controller::Controller(Deps deps, QObject *parent)
    : QObject(parent),
      m_deps(std::move(deps)),
      m_localSessionsDir(m_deps.localSessionsDir)
{
}

Controller::~Controller()
{
    cancel();
}

void Controller::cancel()
{
    // Published state must not change any more: a probe continuation or a queued request
    // that is still in flight belongs to an environment the caller no longer wants (and,
    // on the shutdown path, to services that are about to be destroyed).
    m_cancelled = true;
    if (m_resolver) {
        m_resolver->cancel();
        m_resolver.reset();
    }
    m_busy = false;
    // Both completions are consumed here, so a pending `settings:update` cannot hang on
    // shutdown and no caller closure is destroyed later at an unrelated point.
    finish(m_active);
    finish(m_queued);
}

void Controller::finish(Request &request)
{
    // Consume the completion exactly once, *at the moment it is settled*: the stored copy
    // is emptied first, so no later state assignment can destroy a caller's closure while
    // an unrelated channel request is on the stack.
    std::function<void()> callable = std::move(request.done);
    request = Request{};
    if (callable) callable();
}

void Controller::request(bool enabled, const QString &distro, const QString &user,
                         std::function<void()> done)
{
    Request next;
    next.sequence = ++m_sequence;
    next.enabled = enabled;
    next.distro = distro;
    next.user = user;
    next.done = std::move(done);
    // A settings change after a shutdown-time `cancel()` is a fresh owner again.
    m_cancelled = false;

    // Identity first, exactly like the oracle (`setSessionCatalogIdentityContext` runs
    // before the environment is re-resolved): a draft created while the probe is in
    // flight already carries the new distro/user instead of `unknown`.
    if (m_deps.services) {
        applyIdentityContext(m_deps.services->catalog, enabled, distro, user);
    }

    if (m_busy) {
        // Coalesce: only the newest request defines the environment, and the superseded
        // caller is answered now (its settings were already persisted; the switch follows
        // the newer request). Answering it here — instead of when the probe finishes —
        // keeps exactly one caller completion alive at any time.
        finish(m_queued);
        m_queued = std::move(next);
        return;
    }
    start(std::move(next));
}

void Controller::start(Request request)
{
    m_active = std::move(request);
    m_busy = true;

    if (!m_active.enabled || m_active.distro.isEmpty() || m_active.user.isEmpty()) {
        // Disabled or incomplete settings: no probe, publish the local roots immediately.
        // The oracle clears every manager in that branch instead of keeping the previous
        // distro's directories around.
        commit(wsl::Environment{});
        return;
    }

    wsl::ResolveOptions options;
    options.warn = m_deps.warn;
    auto resolver = std::make_unique<wsl::Resolver>(*m_deps.services, options, this);
    const quint64 sequence = m_active.sequence;
    // The probe answers through the event loop, so the guard has to survive a `cancel()` —
    // and the controller itself being destroyed — before the answer arrives.
    QPointer<Controller> self(this);
    resolver->resolve(m_active.distro, m_active.user,
                      [self, sequence](const wsl::Environment &environment) {
        // Cancelled (shutdown) or destroyed while the probe was running: the resolved
        // environment must not be published, and nothing may be restarted.
        if (!self || self->m_cancelled) return;
        // A superseded probe is dropped by `cancel()`/the sequence check, so a slow older
        // distro can never publish its environment over a newer request.
        if (!self->m_busy || sequence != self->m_active.sequence) return;
        if (self->m_queued.sequence != 0) {
            // A newer request is already waiting: publishing this environment would show
            // the user the distro they just replaced (a transient wrong skill/prompt list
            // and a second, immediately overwritten log line). Drop the older result and
            // go straight to the newest request.
            self->abandonProbe();
            finish(self->m_active);
            self->m_busy = false;
            self->pump();
            return;
        }
        // An invalid environment degrades to the local roots: a broken distro must not
        // hide the user's local skills and sessions behind an error.
        self->commit(environment);
    });
    m_resolver = std::move(resolver);
}

void Controller::abandonProbe()
{
    if (!m_resolver) return;
    // The probe completion runs inside the resolver's own QProcess signal, so the resolver
    // (and the finished process it owns) may only be freed once the callback returned.
    QObject *orphan = m_resolver.release();
    orphan->deleteLater();
}

void Controller::commit(const wsl::Environment &environment)
{
    ChannelServices *services = m_deps.services;
    const QString localSessionsDir = m_localSessionsDir;
    const bool requestedWsl = m_active.enabled;
    const QString requestedDistro = m_active.distro;
    const QString requestedUser = m_active.user;

    // The switch is one synchronous owner-thread block: the pi config directory and the
    // skill/prompt manager locations are read by synchronous channel handlers on this
    // thread, so writing them anywhere else would race those reads (a `QString` assignment
    // against a concurrent copy) and would queue the switch behind unrelated blocking
    // domain work. The scanner publishes an immutable snapshot plus its cancellation
    // token; its summary-cache reload is the only blocking part and is handed to the
    // serial executor from inside `configureEnvironment`.
    if (services) applyEnvironment(*services, environment, localSessionsDir);
    // The extension switch is the one part whose readers are the serial domain executor
    // (`extensions:*` bodies), so it is published there — after the owner-thread state,
    // so the renderer never sees a new pi config dir with the previous distro's
    // extensions for longer than the executor's queue.
    if (services) publishExtensionEnvironment(*services, environment);
    // Deferred, never destroyed here: `commit` usually runs inside the probe's own
    // QProcess completion, so the resolver (and the finished process it owns) may only be
    // freed once that callback returned.
    abandonProbe();
    m_current = environment;
    m_busy = false;
    if (services && services->appLog) {
        if (environment.isValid()) {
            services->appLog->write(
                QStringLiteral("info"), QStringLiteral("wsl"),
                QStringLiteral("WSL environment configured"),
                QJsonObject{{QStringLiteral("distro"), environment.distro},
                            {QStringLiteral("user"), environment.user},
                            {QStringLiteral("linuxHome"), environment.linuxHome}});
        } else if (requestedWsl) {
            // The request asked for WSL but the distro could not be resolved.
            services->appLog->write(
                QStringLiteral("warn"), QStringLiteral("wsl"),
                QStringLiteral("WSL environment unavailable; using the local roots"),
                QJsonObject{{QStringLiteral("distro"), requestedDistro},
                            {QStringLiteral("user"), requestedUser}});
        }
    }
    // Settle this caller before a queued newer request can overwrite anything.
    finish(m_active);
    // A newer request arrived while this one was being published.
    pump();
}

void Controller::pump()
{
    if (m_busy) return;
    if (m_queued.sequence == 0) return;
    Request next = std::move(m_queued);
    m_queued = Request{};
    start(std::move(next));
}

} // namespace wslctl
