#pragma once

#include <QProcessEnvironment>
#include <QStringList>

/**
 * Child process environment policy.
 *
 * The backend itself needs the host bridge credential, but nothing it spawns may
 * inherit it: pi tools, terminals, git and helper processes are all reachable from
 * model output. Ported from src/main/process/sanitizeChildEnvironment.ts so the
 * Node and C++ backends enforce the same rule.
 *
 * Every QProcess the backend creates must be started with `childenv::sanitized()`.
 */
namespace childenv {

/** Names removed unconditionally (host bridge credentials and bridge paths). */
QStringList privateKeys();

/** Sanitize a base environment. Defaults to the process environment. */
QProcessEnvironment sanitized(const QProcessEnvironment &base = QProcessEnvironment::systemEnvironment());

/** True when `environment` still contains a value that must never reach a child. */
bool containsPrivateValue(const QProcessEnvironment &environment);

} // namespace childenv
