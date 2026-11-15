#pragma once

#include "PiLaunch.h"

#include <QString>

/**
 * One-shot execution of a `pilaunch::Cli`.
 *
 * The pi-install and model-list paths need to run `pi --version` / `pi --list-models`
 * exactly the way a session runtime would start pi (same resolved program, same argv,
 * same `cmd.exe /s /c` shim wrap), but they only need the exit status and the captured
 * output. `PiEventClient` is the long-lived RPC transport and `picli` belongs to the
 * extension domain, so this module owns the short-lived case.
 *
 * Invariants:
 *  - argument arrays only; a batch shim is launched through the pre-quoted
 *    `nativeArguments` line produced by `pilaunch` (never re-escaped by QProcess);
 *  - output is bounded (32 MiB) so a runaway pi cannot exhaust the backend;
 *  - the call blocks, so callers must run it on the serial domain executor, never on the
 *    HTTP/SSE main thread.
 */
namespace piprocess {

struct Result {
    bool started = false;
    bool timedOut = false;
    int exitCode = 0;
    QString stdoutText;
    QString stderrText;
    /** Raw bytes, kept because the pi-version probe needs the oracle's GBK fallback. */
    QByteArray stdoutBytes;
    QByteArray stderrBytes;

    /** A clean exit (0). A killed/timed-out child is never a success. */
    bool ok() const { return started && !timedOut && exitCode == 0; }
};

/** Run `cli` with `cli.environment`; `cwd` empty means this process's cwd. */
Result run(const pilaunch::Cli &cli, int timeoutMs, const QString &cwd = QString());

} // namespace piprocess
