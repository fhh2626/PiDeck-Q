#pragma once

#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <functional>

/**
 * One-shot pi process bound to an existing session file.
 *
 * Port of AgentManager.withTemporarySession: `sessions:catalog-copy` and
 * `sessions:catalog-export-html` must use pi's own `clone` / `export_html` RPC so the
 * produced file has pi's exact layout and styling. The backend therefore starts a
 * short-lived `pi --mode rpc --session <path>`, issues one command, reads the state
 * and stops the child — it never re-implements clone or the HTML template.
 */
namespace temporarypi {

struct Result {
    bool ok = false;
    QJsonObject data;
    QString error;
};

using Done = std::function<void(Result)>;

/**
 * Run `command` against `sessionPath` and report its `data` payload.
 * `settings` is the desktop settings object (runtime preference, offline flag, WSL).
 */
void run(const QJsonObject &settings, const QString &cwd, const QString &sessionPath,
         const QJsonObject &command, int timeoutMs, Done done);

/**
 * Officially clone a session (AgentManager.cloneSessionFile).
 *
 * `clone` only copies the active branch; pi reports the new file through `get_state`, so
 * both requests are required. Mirrors the oracle: the result spreads the clone payload
 * (including `cancelled`) and adds the resolved `sessionPath` (absolute for the project /
 * WSL environment). A clone that pi cancels still runs `get_state`, so the caller always
 * sees the same settled shape.
 */
void clone(const QJsonObject &settings, const QString &cwd, const QString &sessionPath,
           const QString &projectPath, const QString &environment, Done done);

/** Build the argv a temporary session uses (exposed for the argv parity test). */
QStringList buildArguments(const QJsonObject &settings, const QString &sessionPath);

} // namespace temporarypi
