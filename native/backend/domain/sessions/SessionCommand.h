#pragma once

#include <QString>

/**
 * Result of one blocking child capture used by the session scanner.
 *
 * Both the WSL filesystem adapter (`SessionFs::runCapture`) and the batch reader
 * (`wslscan`) need the same four facts, and duplicating the struct would let the two
 * definitions drift. The WSL runner and the batch reader are the only users; nothing
 * here is renderer-visible.
 *
 * `stdoutText` keeps the bytes the child produced before it was killed for a timeout.
 * The batch reader's complete-prefix recovery depends on that partial data (the oracle's
 * `WslScanCommandError.stdout`), so a timeout must never clear stdout here.
 */
namespace sessioncmd {

struct Result {
    bool started = false;
    bool timedOut = false;
    /** Output exceeded the caller's ceiling: a failure, but never a timeout. */
    bool truncated = false;
    int exitCode = -1;
    QString stdoutText;
    QString stderrText;
    /** Filename enumeration and physical path identities require lossless stdout decoding. */
    bool stdoutLosslessUtf8 = true;

    /** Clean exit; a missing program, a timeout or an oversized reply is a failure. */
    bool ok() const { return started && !timedOut && !truncated && exitCode == 0; }
};

} // namespace sessioncmd
