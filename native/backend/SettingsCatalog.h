#pragma once

#include <QJsonObject>
#include <QString>

struct SettingsCatalogRead {
    bool ok = false;
    QJsonObject settings;
    QString error;
};

/**
 * The desktop settings store (`<userData>/settings.json`).
 *
 * Port of src/main/settings/SettingsStore.ts. It is the single owner of the settings
 * file: defaults, legacy-field stripping, the localized built-in commit prompt, the web
 * service access token and the display migrations all live here, so no channel module
 * has to know the file format.
 *
 * `agentDir` (`~/.pi/agent`) is needed because `showThinking` is not persisted by PiDeck:
 * it mirrors pi's own `hideThinkingBlock`, and is recomputed on every read.
 *
 * @param agentDir empty means `<home>/.pi/agent`.
 */
SettingsCatalogRead readSettingsCatalog(const QString &filePath, const QString &agentDir = QString());

/** Read the same normalized values without persisting migrations from a read-only worker. */
SettingsCatalogRead readSettingsCatalogSnapshot(const QString &filePath, const QString &agentDir = QString());

/**
 * Apply a patch and persist it.
 *
 * Host-owned fields (`showThinking`, `installationType`) are rejected, an invalid
 * `webServiceAccessToken` is ignored instead of downgrading the web service to a weak
 * token, and a language-only change re-localizes the built-in commit prompt.
 */
SettingsCatalogRead updateSettingsCatalog(const QString &filePath, const QJsonObject &patch,
                                          const QString &agentDir = QString());

/** `^[A-Za-z0-9_-]{32,128}$` (shared/webServiceAccess.ts). */
bool isValidWebServiceAccessToken(const QString &value);

/** Built-in commit prompt for the resolved language (also used by the git domain). */
QString defaultGitCommitMessagePromptFor(const QString &language);
