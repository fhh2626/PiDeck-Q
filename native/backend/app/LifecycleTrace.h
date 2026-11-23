#pragma once

/**
 * Opt-in process-lifecycle trace for shutdown/os-exit investigations.
 *
 * The backend must leave the process within the host's force-kill budget, so a hang
 * after `application.readyToExit` is invisible to the user (the host kills it) but is
 * still a product bug: children can outlive the parent and the exit code is lost.
 * This trace lets a run say exactly which phase it reached and which thread it was on.
 *
 * Disabled by default and free when disabled: with `PIDECK_LIFECYCLE_TRACE` unset,
 * `mark()` costs one static-initialization guard check. When the variable names a file path, every
 * mark is appended (one flushed line: `<uptime-ms> <tid> <phase>`) so a hung process
 * still has its last phase on disk. Intended for tests and manual diagnosis only; the
 * phase names are internal identifiers, not user-visible text.
 */
namespace lifetrace {

/** True when `PIDECK_LIFECYCLE_TRACE` named a writable trace file. */
bool enabled();

/** Append one phase marker (thread-safe, no-op when tracing is off). */
void mark(const char *phase);

} // namespace lifetrace
