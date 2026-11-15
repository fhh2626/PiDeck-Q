#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <vector>

/**
 * External editor discovery and launch.
 *
 * Port of src/main/editors/EditorDetector.ts. Detection order is the oracle's:
 * PATH first (covers custom install roots), then the well-known Windows install
 * paths, then the uninstall registry. A stored command is resolved to something
 * Windows can actually start before it is offered in the editor menu, because a
 * `bin/code` shell script exists but cannot be spawned.
 */
namespace editordetect {

struct Definition {
    QString id;
    QString name;
};

struct Candidate {
    QString id;
    QString name;
    QStringList commands;
    QStringList commonPaths;
    QStringList executableNames;
    QStringList registryNames;
};

/** `SUPPORTED_EXTERNAL_EDITORS` in declaration order. */
std::vector<Definition> supportedEditors();

/** Detected editors as `{id, name, command, detectedFrom}`. */
QJsonArray detectEditors();

/**
 * Resolve a stored command to a launchable path.
 * Returns an empty string when Windows cannot start it.
 */
QString resolveLaunchableCommand(const QString &command);

/** Configured + launchable editors as `[{id, name, command, detectedFrom}]`. */
QJsonArray listConfiguredEditors(const QJsonObject &settings);

/** Merge detections into `externalEditors`, keeping manual overrides. */
QJsonObject mergeDetectedEditors(const QJsonObject &current, const QJsonArray &detected);

/**
 * Launch `editorId`/`command` for `projectPath`.
 *
 * `.cmd`/`.bat` shims go through `cmd /d /s /c start` because a detached spawn of a
 * batch file opens a console window and can fail on paths with spaces. Returns false
 * with `error` when the process could not be started at all.
 */
bool openProjectInEditor(const QString &editorId, const QString &command, const QStringList &args,
                         const QString &projectPath, QString *error);

} // namespace editordetect
