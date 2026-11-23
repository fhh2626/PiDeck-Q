#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

/**
 * Subagent preferences (`subagents` block of pi's settings.json).
 *
 * Port of src/main/subagents/SubagentSettingsStore.ts. The semantics belong to the
 * `pideck-q-subagents` extension, which reads `defaultModel` / `defaultProvider` /
 * `defaultThinking` / `preferDelegation` straight from pi's settings file. PiDeck only
 * provides a graphical editor, so it patches those four keys and preserves everything
 * else in the file (including other `subagents` keys such as `agentOverrides`).
 */
namespace subagents {

/** `{global, project}`; `project` is null when no project is active or known. */
QJsonObject read(const QString &agentDir, const QString &projectPath);

/**
 * Patch one scope. `scope` is `global` or `project`; a project scope requires a path.
 * Throws (as a channel error) on invalid input so nothing is written.
 */
void save(const QString &agentDir, const QString &projectPath, const QString &scope,
          const QJsonValue &settings);

} // namespace subagents
