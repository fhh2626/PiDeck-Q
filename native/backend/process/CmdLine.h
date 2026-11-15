#pragma once

#include <QString>
#include <QStringList>

/**
 * Windows `cmd.exe` command-line quoting.
 *
 * Exact port of `src/main/pi/PiLocator.ts` (`needsCmdQuote` / `quoteCmdArgument` /
 * the Windows branch of `createInvocation`). A `.cmd`/`.bat` shim cannot be started by
 * CreateProcess, so it is launched as `cmd.exe /d /s /c <command line>`: the last
 * argument is a whole command line, and cmd.exe re-parses it. Every element therefore
 * has to be quoted against cmd's metacharacters *before* the line is built.
 *
 * This exists as one helper because three call sites (session launch, extension/npm
 * CLI, locator probe) each carried their own copy and two of them only quoted
 * whitespace. That left `&`, `|`, `^`, `>`, `(`, `)`, ... bare, so a project at
 * `D:\src\R&D` produced `--session ...\--d--src-r&d--\x.jsonl`; cmd split the line at
 * `&` and ran the tail as a second command. The rule is deliberately the oracle's,
 * not a stricter one: `%VAR%` expansion inside quoted arguments is a pre-existing
 * shared behaviour and out of scope here.
 */
namespace cmdline {

/** `needsCmdQuote`: whitespace or any cmd metacharacter (`PiLocator.ts` :583). */
bool needsQuoting(const QString &value);

/** `quoteCmdArgument`: wrap in quotes when needed, doubling embedded quotes (:573). */
QString quoteArgument(const QString &value);

/**
 * `createInvocation`'s Windows command line: every element quoted, plus one outer
 * quote pair *only* when the command itself needs quoting. `cmd /s /c` strips exactly
 * that pair, which is what makes a shim path containing spaces/metacharacters work;
 * an unconditional outer pair would break a bare command name (`cmd` would treat the
 * whole line as the program name).
 */
QString commandLine(const QString &command, const QStringList &arguments);

/**
 * The raw `cmd.exe` argument string for `command arguments...`: `/d /s /c <line>`.
 *
 * `/d` skips the user's `Command Processor\AutoRun` registry command so a launch
 * cannot be hijacked (or slowed) by it; the oracle emits the same three flags.
 */
QString nativeArguments(const QString &command, const QStringList &arguments);

/**
 * Oracle `EditorDetector.quoteCmdArg` (`:350`): always quoted, inner `"` escaped.
 *
 * Deliberately *not* `quoteArgument`: the editor launch has a different (also shipped)
 * oracle rule, because `start "" <program>` needs a quoted program token and the editor
 * path forwards renderer-provided `args`. Keeping that exact rule here means one
 * implementation per oracle policy instead of a fourth ad-hoc copy in the launcher.
 */
QString startArgument(const QString &value);

} // namespace cmdline
