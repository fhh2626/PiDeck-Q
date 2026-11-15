#include "SecurityCatalog.h"

#include "JsonFile.h"
#include "SecurityCatalogInternal.h"
#include "SettingsCatalog.h"

#include <QDir>
#include <QJsonDocument>
#include <QJsonValue>
#include <QRegularExpression>
#include <QSet>

namespace security {
namespace {

using internal::kSecurityTools;

bool validDirectoryEntry(const QJsonValue &value)
{
    if (!value.isString()) return false;
    const QString text = value.toString();
    if (text.trimmed().isEmpty() || text.contains(QChar(0))) return false;
    const QString slashed = QString(text).replace(QLatin1Char('\\'), QLatin1Char('/'));
    if (slashed.startsWith(QStringLiteral("//?/")) || slashed.startsWith(QStringLiteral("//./"))) {
        return false;
    }
    static const QRegularExpression drive(QStringLiteral("^[a-zA-Z]:"));
    static const QRegularExpression driveAbsolute(QStringLiteral("^[a-zA-Z]:/"));
    if (drive.match(slashed).hasMatch() && !driveAbsolute.match(slashed).hasMatch()) return false;
    return true;
}

QStringList errorsOf(const QJsonObject &config)
{
    return validateConfig(config);
}

bool writeSnapshot(const QString &snapshotPath, const QJsonObject &config, QString *error)
{
    QJsonObject snapshot = buildSnapshot(config);
    QString writeError;
    if (!jsonfile::writeJsonAtomic(snapshotPath, snapshot, &writeError)) {
        if (error) *error = writeError;
        return false;
    }
    return true;
}

QString settingsPathOf(const QString &settingsPath)
{
    return settingsPath;
}

} // namespace

QStringList validateConfig(const QJsonObject &config)
{
    QStringList errors;
    if (config.isEmpty()) {
        errors.append(QStringLiteral("配置必须是非空对象"));
        return errors;
    }
    if (!config.value(QStringLiteral("enabled")).isBool()) {
        errors.append(QStringLiteral("enabled 必须是 boolean"));
    }
    const QJsonValue levelsValue = config.value(QStringLiteral("levels"));
    if (!levelsValue.isArray() || levelsValue.toArray().isEmpty()) {
        errors.append(QStringLiteral("levels 不能为空"));
        return errors;
    }
    QSet<QString> seen;
    for (const QJsonValue &value : levelsValue.toArray()) {
        if (!value.isObject()) {
            errors.append(QStringLiteral("level 项必须是非空对象"));
            continue;
        }
        const QJsonObject levelObject = value.toObject();
        const QString id = levelObject.value(QStringLiteral("id")).toString();
        if (id.trimmed().isEmpty() || seen.contains(id)) {
            errors.append(QStringLiteral("等级 id 重复或为空: %1")
                              .arg(id.isEmpty() ? QStringLiteral("(空)") : id));
        } else {
            seen.insert(id);
        }
        const QString label = id.isEmpty() ? QStringLiteral("(未知)") : id;
        if (!levelObject.value(QStringLiteral("name")).isString()
            || !levelObject.value(QStringLiteral("description")).isString()) {
            errors.append(QStringLiteral("等级 %1 名称或描述必须为字符串").arg(label));
        }
        if (levelObject.contains(QStringLiteral("builtin"))
            && !levelObject.value(QStringLiteral("builtin")).isBool()) {
            errors.append(QStringLiteral("等级 %1 builtin 必须是 boolean").arg(label));
        }
        if (levelObject.value(QStringLiteral("builtin")).toBool() && id != QStringLiteral("off")
            && id != QStringLiteral("standard") && id != QStringLiteral("strict")) {
            errors.append(QStringLiteral("内置等级 id 非法: %1").arg(id));
        }
        const QString defaultAction = levelObject.value(QStringLiteral("defaultAction")).toString();
        if (defaultAction != QStringLiteral("allow") && defaultAction != QStringLiteral("ask")
            && defaultAction != QStringLiteral("deny")) {
            errors.append(QStringLiteral("等级 %1 defaultAction 非法: %2").arg(label, defaultAction));
        }
        const QString pathPolicy = levelObject.value(QStringLiteral("pathPolicy")).toString();
        if (pathPolicy != QStringLiteral("unrestricted") && pathPolicy != QStringLiteral("workspace")
            && pathPolicy != QStringLiteral("custom")) {
            errors.append(QStringLiteral("等级 %1 pathPolicy 非法: %2").arg(label, pathPolicy));
        }
        if (!levelObject.value(QStringLiteral("protectSensitivePaths")).isBool()) {
            errors.append(QStringLiteral("等级 %1 protectSensitivePaths 必须是 boolean").arg(label));
        }
        const QJsonValue toolActions = levelObject.value(QStringLiteral("toolActions"));
        if (!toolActions.isObject()) {
            errors.append(QStringLiteral("等级 %1 toolActions 必须是对象").arg(label));
        } else {
            const QJsonObject actions = toolActions.toObject();
            for (auto iterator = actions.begin(); iterator != actions.end(); ++iterator) {
                if (!kSecurityTools.contains(iterator.key())) {
                    errors.append(QStringLiteral("等级 %1 包含未知工具: %2").arg(id, iterator.key()));
                }
                const QString action = iterator.value().toString();
                if (action != QStringLiteral("allow") && action != QStringLiteral("ask")
                    && action != QStringLiteral("deny")) {
                    errors.append(QStringLiteral("等级 %1 工具 %2 动作非法: %3")
                                      .arg(id, iterator.key(), action));
                }
            }
        }
        const QJsonValue bash = levelObject.value(QStringLiteral("denyBashPatterns"));
        if (!bash.isArray()) {
            errors.append(QStringLiteral("等级 %1 denyBashPatterns 必须是数组").arg(label));
        } else {
            for (const QJsonValue &pattern : bash.toArray()) {
                if (!pattern.isString()) {
                    errors.append(QStringLiteral("等级 %1 危险命令模式必须是字符串").arg(id));
                    continue;
                }
                // An uncompilable pattern would make the extension crash on every command.
                if (!QRegularExpression(pattern.toString()).isValid()) {
                    errors.append(QStringLiteral("等级 %1 危险命令正则无法编译: %2")
                                      .arg(id, pattern.toString()));
                }
            }
        }
        if (levelObject.contains(QStringLiteral("denyPowerShellPatterns"))) {
            const QJsonValue powerShell = levelObject.value(QStringLiteral("denyPowerShellPatterns"));
            if (!powerShell.isArray()) {
                errors.append(QStringLiteral("等级 %1 denyPowerShellPatterns 必须是数组").arg(label));
            } else {
                for (const QJsonValue &pattern : powerShell.toArray()) {
                    if (!pattern.isString()) {
                        errors.append(QStringLiteral("等级 %1 PowerShell 危险命令模式必须是字符串").arg(id));
                        continue;
                    }
                    if (!QRegularExpression(pattern.toString()).isValid()) {
                        errors.append(QStringLiteral("等级 %1 PowerShell 危险命令正则无法编译: %2")
                                          .arg(id, pattern.toString()));
                    }
                }
            }
        }
        for (const QString &key : {QStringLiteral("customAllowDirs"), QStringLiteral("denyDirs")}) {
            const QJsonValue dirs = levelObject.value(key);
            if (!dirs.isArray()) {
                errors.append(QStringLiteral("等级 %1 %2 必须是数组").arg(label, key));
                continue;
            }
            for (const QJsonValue &dir : dirs.toArray()) {
                if (!validDirectoryEntry(dir)) {
                    errors.append(QStringLiteral("等级 %1 %2 包含非法目录: %3")
                                      .arg(id, key, dir.toString()));
                }
            }
        }
    }
    const QString defaultLevelId = config.value(QStringLiteral("defaultLevelId")).toString();
    if (defaultLevelId.isEmpty() || !seen.contains(defaultLevelId)) {
        errors.append(QStringLiteral("默认等级不存在: %1")
                          .arg(defaultLevelId.isEmpty() ? QStringLiteral("(空)") : defaultLevelId));
    }
    if (config.contains(QStringLiteral("sessionOverrides"))) {
        const QJsonValue overrides = config.value(QStringLiteral("sessionOverrides"));
        if (!overrides.isObject()) {
            errors.append(QStringLiteral("sessionOverrides 必须是对象"));
        } else {
            const QJsonObject map = overrides.toObject();
            for (auto iterator = map.begin(); iterator != map.end(); ++iterator) {
                const QString levelId = iterator.value().toString();
                if (!iterator.value().isString() || levelId.trimmed().isEmpty()
                    || !seen.contains(levelId)) {
                    errors.append(QStringLiteral("会话覆盖 %1 指向不存在或非法的等级: %2")
                                      .arg(iterator.key(), levelId));
                }
            }
        }
    }
    return errors;
}

QJsonObject buildSnapshot(const QJsonObject &config)
{
    return QJsonObject{
        {QStringLiteral("schemaVersion"), 1},
        {QStringLiteral("enabled"), config.value(QStringLiteral("enabled")).toBool(false)},
        {QStringLiteral("defaultLevelId"), resolveLevelId(config, QString())},
        {QStringLiteral("levels"), config.value(QStringLiteral("levels")).toArray()},
        {QStringLiteral("sessionLevels"), config.value(QStringLiteral("sessionOverrides")).toObject()},
    };
}

QString resolveLevelId(const QJsonObject &config, const QString &sessionId)
{
    if (!sessionId.isEmpty()) {
        const QString override =
            config.value(QStringLiteral("sessionOverrides")).toObject().value(sessionId).toString();
        if (!override.isEmpty()) return override;
    }
    const QString defaultLevel = config.value(QStringLiteral("defaultLevelId")).toString();
    return defaultLevel.isEmpty() ? QStringLiteral("standard") : defaultLevel;
}

QJsonObject readConfig(const QString &settingsPath)
{
    const SettingsCatalogRead settings = readSettingsCatalog(settingsPath);
    if (!settings.ok) return defaultConfig();
    return normalizeConfig(settings.settings.value(QStringLiteral("securityConfig")).toObject());
}

bool ensureSnapshot(const QString &settingsPath, const QString &snapshotPath, QString *error)
{
    return writeSnapshot(snapshotPath, readConfig(settingsPath), error);
}

UpdateResult updateConfig(const QString &settingsPath, const QString &snapshotPath,
                          const QString &agentDir, const QJsonObject &patch)
{
    UpdateResult result;
    const QJsonObject current = readConfig(settingsPath);
    QJsonObject next = current;
    for (auto iterator = patch.begin(); iterator != patch.end(); ++iterator) {
        next.insert(iterator.key(), iterator.value());
    }
    if (!patch.contains(QStringLiteral("levels"))) {
        next.insert(QStringLiteral("levels"), current.value(QStringLiteral("levels")));
    }

    if (patch.contains(QStringLiteral("levels"))
        && !patch.contains(QStringLiteral("sessionOverrides"))) {
        // Validate the level table first, then drop only the overrides that referenced a
        // level this patch removed. Explicitly submitted overrides are validated below.
        QJsonObject levelOnly = next;
        levelOnly.insert(QStringLiteral("sessionOverrides"), QJsonObject{});
        const QStringList levelErrors = errorsOf(levelOnly);
        if (!levelErrors.isEmpty()) {
            result.error = QStringLiteral("安全配置校验失败: ") + levelErrors.join(QStringLiteral("; "));
            result.code = QStringLiteral("VALIDATION_FAILED");
            return result;
        }
        QSet<QString> activeIds;
        for (const QJsonValue &value : next.value(QStringLiteral("levels")).toArray()) {
            activeIds.insert(value.toObject().value(QStringLiteral("id")).toString());
        }
        QSet<QString> removedIds;
        for (const QJsonValue &value : current.value(QStringLiteral("levels")).toArray()) {
            const QString id = value.toObject().value(QStringLiteral("id")).toString();
            if (!activeIds.contains(id)) removedIds.insert(id);
        }
        QJsonObject keptOverrides;
        const QJsonObject overrides = next.value(QStringLiteral("sessionOverrides")).toObject();
        for (auto iterator = overrides.begin(); iterator != overrides.end(); ++iterator) {
            if (removedIds.contains(iterator.value().toString())) continue;
            keptOverrides.insert(iterator.key(), iterator.value());
        }
        next.insert(QStringLiteral("sessionOverrides"), keptOverrides);
    }

    const QStringList errors = errorsOf(next);
    if (!errors.isEmpty()) {
        result.error = QStringLiteral("安全配置校验失败: ") + errors.join(QStringLiteral("; "));
        result.code = QStringLiteral("VALIDATION_FAILED");
        return result;
    }
    const QJsonObject normalized = normalizeConfig(next);
    // Settings first, snapshot second: a snapshot failure means "not confirmed", and the
    // next successful update (or the startup barrier) republishes it.
    const SettingsCatalogRead saved = updateSettingsCatalog(
        settingsPathOf(settingsPath),
        QJsonObject{{QStringLiteral("securityConfig"), normalized}}, agentDir);
    if (!saved.ok) {
        result.error = saved.error;
        result.code = QStringLiteral("UNKNOWN_ERROR");
        return result;
    }
    QString snapshotError;
    if (!writeSnapshot(snapshotPath, normalized, &snapshotError)) {
        result.error = QStringLiteral("Failed to write security policy snapshot: ") + snapshotError;
        result.code = QStringLiteral("SNAPSHOT_WRITE_FAILED");
        result.config = normalized;
        return result;
    }
    result.ok = true;
    result.config = normalized;
    return result;
}

UpdateResult setSessionLevel(const QString &settingsPath, const QString &snapshotPath,
                             const QString &agentDir, const QString &sessionId,
                             const QString &levelId)
{
    UpdateResult result;
    const QJsonObject current = readConfig(settingsPath);
    QJsonObject overrides = current.value(QStringLiteral("sessionOverrides")).toObject();
    if (levelId.isEmpty()) {
        overrides.remove(sessionId);
    } else {
        bool exists = false;
        for (const QJsonValue &value : current.value(QStringLiteral("levels")).toArray()) {
            if (value.toObject().value(QStringLiteral("id")).toString() == levelId) exists = true;
        }
        if (!exists) {
            result.error = QStringLiteral("安全等级不存在: ") + levelId;
            result.code = QStringLiteral("VALIDATION_FAILED");
            return result;
        }
        overrides.insert(sessionId, levelId);
    }
    QJsonObject next = current;
    next.insert(QStringLiteral("sessionOverrides"), overrides);
    const QStringList errors = errorsOf(next);
    if (!errors.isEmpty()) {
        result.error = QStringLiteral("安全配置校验失败: ") + errors.join(QStringLiteral("; "));
        result.code = QStringLiteral("VALIDATION_FAILED");
        return result;
    }
    const QJsonObject normalized = normalizeConfig(next);
    const SettingsCatalogRead saved = updateSettingsCatalog(
        settingsPathOf(settingsPath),
        QJsonObject{{QStringLiteral("securityConfig"), normalized}}, agentDir);
    if (!saved.ok) {
        result.error = saved.error;
        result.code = QStringLiteral("UNKNOWN_ERROR");
        return result;
    }
    QString snapshotError;
    if (!writeSnapshot(snapshotPath, normalized, &snapshotError)) {
        result.error = QStringLiteral("Failed to write security policy snapshot: ") + snapshotError;
        result.code = QStringLiteral("SNAPSHOT_WRITE_FAILED");
        result.config = normalized;
        return result;
    }
    result.ok = true;
    result.config = normalized;
    return result;
}

} // namespace security
