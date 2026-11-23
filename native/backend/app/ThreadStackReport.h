#pragma once

/**
 * Opt-in thread-stack report for hung-process diagnosis.
 *
 * The backend can only be debugged on a developer machine with a debugger attached, and
 * the shutdown hang this exists for leaves no stack anywhere: the host force-kills the
 * process 1500 ms after `application.readyToExit`, so the interesting state is gone.
 * A test or a manual run can therefore ask the process to report *its own* stacks:
 *
 *   PIDECK_STACK_DUMP_MS=3000            # delay after start before the report
 *   PIDECK_STACK_DUMP_FILE=...\stacks.txt
 *
 * After the delay a watchdog thread walks every thread of this process with DbgHelp and
 * appends one block per thread to the file (module!symbol+offset, file:line when the PDB
 * is present). The process keeps running: the report is not a crash handler and must not
 * change shutdown behaviour. Windows only; `enabled()` is false everywhere else so the
 * call site stays a single early-return in main().
 */
namespace stackreport {

/** True when the environment asked for a stack report on this platform. */
bool enabled();

/** Start the one-shot watchdog; no-op when `enabled()` is false. */
void arm();

} // namespace stackreport
