#pragma once

#include <QJsonObject>
#include <QObject>
#include <QString>

#include <functional>

struct ChannelServices;
class QProcess;
class QTimer;

/**
 * Resolved WSL environment for one distro/user pair.
 *
 * Port of src/main/wsl/WslPaths.ts (`createWslEnvironment`) + WslEnvironment.ts
 * (`resolveWslEnvironment`). The startup tasks resolve it exactly once and hand the
 * result to every owner that has to switch directories, so `wsl.exe printenv HOME` runs
 * one time per launch instead of once per manager (the oracle's comment says the same).
 *
 * Why `windowsHome` exists: skills, prompts, extensions and the pi config directory are
 * read through the Windows filesystem as UNC paths. Building them by hand from
 * `\\wsl$\<distro>\home\<user>` is wrong for `root` (home is `/root`) and for custom
 * homes, so the UNC path is always derived from the *resolved* Linux home.
 */
namespace wsl {

struct Environment {
    QString distro;
    QString user;
    /** Absolute Linux home inside the distribution (`/home/<user>`). */
    QString linuxHome;
    /** `\\wsl.localhost\<distro>\home\<user>`: what the Windows-side managers use. */
    QString windowsHome;

    bool isValid() const { return !distro.isEmpty() && !linuxHome.isEmpty(); }
};

/** Oracle default; a fixture may replace it so no test needs a real distro. */
QString defaultUncRoot();

/** `normalizePosix(...)` for an absolute Linux path; trailing slashes are dropped. */
QString normalizeLinuxPath(const QString &path);

/**
 * `/root` → `\\wsl.localhost\<distro>\root`.
 *
 * A relative or empty path is rejected (empty string) instead of being glued onto the
 * UNC root, exactly like `linuxPathToWslUnc`'s INVALID_WSL_PATH.
 */
QString linuxPathToWslUnc(const QString &linuxPath, const QString &distro,
                          const QString &uncRoot = QString());

/** `/root` for root, `/home/<user>` otherwise — WslEnvironment.ts `fallbackHome`. */
QString fallbackLinuxHome(const QString &user);

struct CreateResult {
    bool ok = false;
    Environment environment;
    QString error;
};

/** Validate + normalize one resolved HOME (`createWslEnvironment`). */
CreateResult createEnvironment(const QString &distro, const QString &user, const QString &linuxHome,
                               const QString &uncRoot = QString());

struct ResolveOptions {
    /** `printenv HOME` budget; the oracle uses 8 s because a cold distro is slow. */
    int timeoutMs = 8'000;
    /** Fixture seam for the UNC root; empty uses `\\wsl.localhost`. */
    QString uncRoot;
    /** Called with the compatibility-fallback detail (never contains user data). */
    std::function<void(const QString &message, const QJsonObject &detail)> warn;
};

/**
 * Asynchronous `wsl -d <distro> -u <user> --exec printenv HOME`.
 *
 * The oracle awaits `execFile` so the JS loop keeps serving RPC while a cold distro
 * boots; blocking here would stall every channel (and the renderer heartbeat) for up to
 * the full 8 s budget. The callback therefore always runs on the thread that created the
 * resolver, exactly once — including the fallback path.
 */
class Resolver : public QObject {
public:
    Resolver(const ChannelServices &services, ResolveOptions options, QObject *parent = nullptr);
    ~Resolver() override;

    /** Start the probe. A second call before completion is rejected (programming error). */
    void resolve(const QString &distro, const QString &user,
                 std::function<void(const Environment &)> done);

    /** Kill a probe in flight and drop its callback (shutdown path). Idempotent. */
    void cancel();

    bool running() const { return m_process != nullptr; }

private:
    void settle(const QString &distro, const QString &user, const QString &stdoutText,
                const QString &errorText);
    void finish(const Environment &environment);

    QString m_executable;
    ResolveOptions m_options;
    QProcess *m_process = nullptr;
    QTimer *m_timeout = nullptr;
    std::function<void(const Environment &)> m_done;
};

} // namespace wsl
