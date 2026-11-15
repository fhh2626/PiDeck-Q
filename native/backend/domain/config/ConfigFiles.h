#pragma once

#include "MainCopy.h"

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

/**
 * pi global configuration files (`~/.pi/agent/{models,auth,settings,trust}.json`).
 *
 * Port of src/main/config/ConfigManager.ts's read/write/validate surface. The files are
 * shared with pi itself and with the extensions, so the writer must keep the exact
 * two-space JSON shape and must never leave a truncated file behind.
 *
 * Secrets: `auth.json` and `models.json` carry API keys. Nothing here logs a value; the
 * diagnostics only ever describe structure.
 */
namespace configfiles {

/** `{raw, parsed, diagnostic?, readError?}` exactly like `ConfigFileReadResult`. */
struct FileRead {
    QString raw;
    QJsonValue parsed;
    bool hasDiagnostic = false;
    QJsonObject diagnostic;
    bool readError = false;
};

struct Validation {
    bool valid = false;
    QString error;
    QString debugDetails;
};

/** Read one config file; a missing file yields the fallback without a diagnostic. */
FileRead read(const QString &configDir, const QString &fileName, const QJsonValue &fallback);

/** Validate and write `models.json` (api aliases are normalized for pi). */
Validation saveModels(const QString &configDir, const QJsonValue &data, const maincopy::Translator &t);

/** Write `auth.json` verbatim (pi owns the schema). */
Validation saveAuth(const QString &configDir, const QJsonValue &data);

/** Write pi's own `settings.json` verbatim. */
Validation saveSettings(const QString &configDir, const QJsonValue &data);

/** Raw source-editor save: JSON syntax is checked, only the four known files are allowed. */
Validation saveRaw(const QString &configDir, const QString &fileName, const QString &rawJson,
                    const maincopy::Translator &t);

/** `{version, exportedAt, files:{models.json, auth.json, settings.json}}` as a JSON string. */
QString exportPackage(const QString &configDir);

/** Restore the three known files from an exported package. */
Validation importPackage(const QString &configDir, const QString &packageJson,
                         const maincopy::Translator &t);

/** `normalizeApiType`: legacy aliases map onto the names pi's registry knows. */
QString normalizeApiType(const QString &apiType);

} // namespace configfiles
