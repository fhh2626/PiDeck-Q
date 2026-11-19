#pragma once

#include "../runtime/PiLaunch.h"

#include <QJsonObject>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>

/**
 * One `<pi> <args>` CLI invocation for the extension domain.
 *
 * Port of `ExtensionManager.runPi`. The program is resolved through
 * `pilaunch::buildCli` (settings → custom path / runtime preference / WSL / PATH), so
 * the renderer can never name an executable, and the child environment is sanitized.
 *
 * `--approve` is only appended for pi versions that support the flag, and
 * `PI_OFFLINE=1` is only set for the TypeScript runtime (the Rust build ignores it).
 */
namespace picli {

struct Result {
    int exitCode = 0;
    QString stdoutText;
    QString stderrText;
    bool started = false;
    bool timedOut = false;
    /** Whether the existing text decoding preserved every stdout byte. */
    bool stdoutLosslessUtf8 = true;

    bool ok() const { return started && !timedOut && exitCode == 0; }
    /** First non-empty stderr line, or a generic message. */
    QString errorMessage() const;
};

/**
 * Run one pi CLI command. `offline` keeps list/remove/install off the network; `update`
 * must pass false so npm actually runs.
 */
Result run(const QJsonObject &settings, const QStringList &arguments, int timeoutMs, bool offline);

/** `<pi> --version`, cached per resolved command (empty when the probe failed). */
QString version(const QJsonObject &settings);

/**
 * Run an arbitrary executable (npm, npx, wsl) with a sanitized environment and an
 * argument array. A bare name is resolved through PATH and wrapped for `cmd.exe` when it
 * turns out to be a batch shim, so `npm.cmd` works on Windows without a shell string.
 */
Result runCommand(const QString &program, const QStringList &arguments, int timeoutMs);

/**
 * Resolve `program` and produce the exact `QProcess` launch for it.
 *
 * A bare name is looked up in `environment`'s PATH (version-manager directories a
 * desktop launch does not inherit) and a `.cmd`/`.bat` shim is wrapped for
 * CreateProcess, because a batch file cannot be started directly. The blocking runner
 * and the asynchronous WSL probe both go through this function so the shim rule has a
 * single owner instead of drifting between a sync and an async copy.
 */
pilaunch::Cli buildCli(const QString &program, const QStringList &arguments,
                       const QProcessEnvironment &environment);

/** Overrides for `runCommand`; empty members keep the defaults above. */
struct CommandOptions {
    /** Explicit child environment; empty means `childenv::sanitized()`. */
    QProcessEnvironment environment;
    /** Child working directory; empty means inherit this process's cwd. */
    QString workingDirectory;
    /**
     * Stdout ceiling in bytes; 0 keeps the 32 MiB default.
     * The WSL scan batch reads transcripts with a 64 MiB per-file budget, which the
     * default runner ceiling would truncate into a bogus "failed" read.
     */
    qint64 maxOutputBytes = 0;
};

/**
 * Same runner with an explicit environment/cwd. The pi-install domain needs the
 * locator's rebuilt PATH (version managers) and `npm_config_*` flags, which the
 * sanitized-only default cannot express.
 */
Result runCommand(const QString &program, const QStringList &arguments, int timeoutMs,
                  const CommandOptions &options);

} // namespace picli
