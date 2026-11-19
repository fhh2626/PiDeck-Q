#pragma once

#include <QJsonObject>
#include <QObject>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>

#include <functional>

/**
 * pi command resolution and launch arguments for session runtimes.
 *
 * Port of the parts of src/main/pi/PiLocator.ts + src/main/pi/PiProcess.ts that decide
 * *what* to spawn and *with which* arguments/environment. The renderer never supplies
 * an executable: the command comes from settings (custom path, runtime preference,
 * WSL) and a PATH search, exactly like the Node oracle.
 *
 * Invariants enforced here:
 *  - argument arrays only, never a shell string;
 *  - the child environment is `childenv::sanitized()` plus the explicitly allowed
 *    PiDeck variables (security snapshot, session identity, UI language, desktop flag);
 *  - `--session` / `--extension` paths are converted to Linux paths under WSL;
 *  - project resources load automatically on pi versions with an approval flag.
 */
namespace pilaunch {

struct Request {
    QJsonObject settings;
    /** Packaged/dev `resources` directory that contains `extensions/`. */
    QString resourcesDir;
    /** Project directory (host path) used as the pi working directory. */
    QString projectPath;
    /** Existing session JSONL (host path); empty for a new session. */
    QString sessionPath;
    bool noSession = false;
    /** SessionRecord.id, injected as PIDECK_SESSION_ID for the security gate. */
    QString securitySessionId;
    /**
     * `wsl.exe` override for the WSL runtime (`PIDECK_WSL_EXE`).
     *
     * Production leaves it empty and the System32/PATH shim is used; the parity tests
     * point it at a fake wsl so a WSL spawn never needs a real distro (the scanner and
     * the WSL probes already use the same seam).
     */
    QString wslExe;
    QString securitySnapshotPath;
    QString uiLocale;
    /** Automatic upstream compatibility flag, enabled after a successful version probe. */
    bool approveProjectResources = false;
};

struct Launch {
    QString program;
    QStringList arguments;
    QString cwd;
    QProcessEnvironment environment;
    bool viaWsl = false;
    /**
     * Raw Windows command line for `program` (only set when pi is an npm `.cmd`/`.bat`
     * shim or a bare name). QProcess re-escapes `arguments`, so a pre-quoted command
     * line for `cmd.exe /d /s /c` must be handed over verbatim instead.
     */
    QString nativeArguments;
    /** Same, for the `--version` probe. */
    QString nativeVersionArguments;
    /** `wsl.exe ... -- pi --version`: the probe must ask the distro's pi. */
    QStringList versionArguments;
};

/** ts | rust | bolt | unknown, derived from the resolved command and the preference. */
QString runtimeKind(const QJsonObject &settings, const QString &program);

/** Whether this Pi version accepts `--approve` to load project resources without a prompt. */
bool supportsProjectApprovalFlag(const QString &version);

/** Absolute paths of the built-in extensions to inject with `--extension`. */
QStringList activeBuiltInExtensions(const QString &resourcesDir, const QJsonObject &settings);

/** Build the launch (program, argv, cwd, env) for one session runtime. */
Launch build(const Request &request);

/**
 * Resolve the pi executable for a plain CLI invocation (`pi list`, `pi install`,
 * `pi update`, ...).
 *
 * The extension domain must never build a command line itself: the program comes from
 * settings (custom path, runtime preference, WSL) and a PATH search, the child
 * environment is sanitized, and the npm `.cmd` shim is wrapped exactly like a session
 * launch. Only the arguments differ from `build()`.
 */
struct Cli {
    QString program;
    QStringList arguments;
    QProcessEnvironment environment;
    bool viaWsl = false;
    /** ts | rust | bolt | unknown, derived from the *resolved* pi (before the shim wrap). */
    QString runtimeKind;
    /** Raw command line for `cmd.exe /d /s /c` when the resolved pi is a batch shim. */
    QString nativeArguments;
};

/** Resolve `<pi> <arguments>` for a non-RPC CLI call. */
Cli buildCli(const QJsonObject &settings, const QStringList &arguments);

/**
 * The `--version` answer already probed for this command, or an empty string when no
 * probe ran in this process yet. Startup uses it instead of forking pi just for a hint.
 */
QString cachedVersion(const Launch &launch);

/** Own pending version probes and cancel their callbacks before the runtime graph is destroyed. */
class VersionProbeOwner final : public QObject {
public:
    explicit VersionProbeOwner(QObject *parent = nullptr) : QObject(parent) {}
    ~VersionProbeOwner() override;
    /** Stop all probes within one short reap budget. This owner cannot start new probes afterward. */
    void cancel();
    bool cancelled() const { return m_cancelled; }

private:
    bool m_cancelled = false;
};

/**
 * Probe `<program> --version` once per command; the callback receives the raw version
 * string (empty when the probe failed). Successful results are cached for the process
 * lifetime; failures can be retried. Every active invocation completes exactly once.
 * Cancelling or destroying its owner stops the child and discards the callback.
 */
void probeVersion(const Launch &launch, VersionProbeOwner &owner,
                  std::function<void(const QString &version)> done);

/**
 * Win<->WSL path mapping for launch arguments, the pi working directory and the
 * `--session`/`--extension` values (port of `src/main/wsl/WslPaths.ts`).
 *
 * Handles all three shapes the renderer can store for a WSL project: a Windows drive
 * path, an `/mnt/<drive>/...` Linux path, and the `\\wsl.localhost\<distro>\...` UNC share.
 * `distro` is only used to reject a UNC path from a different distribution and to build
 * the UNC form for a distro-internal path; an empty value keeps the mapping permissive.
 * Returns an empty string when the input has no representation in the target namespace.
 */
QString toWslLinuxPath(const QString &windowsPath, const QString &distro = QString());
QString toWindowsHostPath(const QString &linuxPath, const QString &distro = QString());

/**
 * Append one name to a `WSLENV` value (colon separated, no `/p` flag).
 *
 * `wsl.exe` only forwards variables registered here, so every PiDeck variable that must
 * reach pi inside the distro goes through this helper instead of string concatenation.
 */
QString appendWslEnvName(const QString &value, const QString &name);

/**
 * Remove one name from a `WSLENV` value, keeping every other entry.
 *
 * Returns an empty string when nothing is left, so the caller can drop the variable
 * entirely instead of leaving `WSLENV=""` (which `wsl.exe` reads as "no names").
 */
QString withoutWslEnvName(const QString &value, const QString &name);

} // namespace pilaunch
