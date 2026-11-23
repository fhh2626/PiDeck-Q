#include "ChannelContext.h"

#include "SecurityCatalog.h"

#include <QDir>
#include <QJsonArray>
#include <QJsonObject>

namespace {

QString settingsPath(const ChannelServices &services)
{
    return QDir(services.userDataDir).filePath(QStringLiteral("settings.json"));
}

QString snapshotPath(const ChannelServices &services)
{
    return QDir(services.userDataDir).filePath(QStringLiteral("security-policy.json"));
}

QJsonValue resultJson(const security::UpdateResult &result)
{
    if (result.ok) {
        return QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("config"), result.config}};
    }
    return QJsonObject{{QStringLiteral("ok"), false},
                       {QStringLiteral("error"), result.error},
                       {QStringLiteral("code"), result.code}};
}

/**
 * Whitelist the renderer's patch.
 *
 * A field that is present but malformed rejects the whole patch instead of being
 * dropped: dropping `sessionOverrides` would look like "no override change" and could
 * silently clear inherited overrides, and dropping `levels` would report success for a
 * patch that never applied. The oracle surfaces the same class of failure as
 * `UNKNOWN_ERROR` (an uncaught TypeError); a structured `VALIDATION_FAILED` is the
 * deliberate divergence here.
 */
bool sanitizePatch(const QJsonValue &value, QJsonObject *out)
{
    if (!value.isObject()) return false;
    const QJsonObject raw = value.toObject();
    QJsonObject patch;
    if (raw.contains(QStringLiteral("enabled"))) {
        if (!raw.value(QStringLiteral("enabled")).isBool()) return false;
        patch.insert(QStringLiteral("enabled"), raw.value(QStringLiteral("enabled")));
    }
    if (raw.contains(QStringLiteral("defaultLevelId"))) {
        if (!raw.value(QStringLiteral("defaultLevelId")).isString()) return false;
        patch.insert(QStringLiteral("defaultLevelId"), raw.value(QStringLiteral("defaultLevelId")));
    }
    if (raw.contains(QStringLiteral("levels"))) {
        if (!raw.value(QStringLiteral("levels")).isArray()) return false;
        patch.insert(QStringLiteral("levels"), raw.value(QStringLiteral("levels")));
    }
    if (raw.contains(QStringLiteral("sessionOverrides"))) {
        const QJsonValue overrides = raw.value(QStringLiteral("sessionOverrides"));
        if (!overrides.isObject()) return false;
        QJsonObject map;
        const QJsonObject source = overrides.toObject();
        for (auto iterator = source.begin(); iterator != source.end(); ++iterator) {
            if (!iterator.value().isString()) return false;
            map.insert(iterator.key(), iterator.value());
        }
        patch.insert(QStringLiteral("sessionOverrides"), map);
    }
    *out = patch;
    return true;
}

} // namespace

void registerSecurityChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("security:get-config"), [&services](const QJsonArray &) {
        return QJsonValue(security::readConfig(settingsPath(services)));
    });

    registry.add(QStringLiteral("security:update-config"), [&services](const QJsonArray &args) {
        QJsonObject patch;
        if (!sanitizePatch(channels::argAt(args, 0), &patch)) {
            return QJsonValue(QJsonObject{{QStringLiteral("ok"), false},
                                          {QStringLiteral("error"), QStringLiteral("安全配置补丁格式非法")},
                                          {QStringLiteral("code"), QStringLiteral("VALIDATION_FAILED")}});
        }
        return resultJson(security::updateConfig(settingsPath(services), snapshotPath(services),
                                                 services.agentDir, patch));
    });

    registry.add(QStringLiteral("security:set-session-level"), [&services](const QJsonArray &args) {
        const QJsonValue sessionValue = channels::argAt(args, 0);
        if (!sessionValue.isString() || sessionValue.toString().trimmed().isEmpty()) {
            return QJsonValue(QJsonObject{{QStringLiteral("ok"), false},
                                          {QStringLiteral("error"), QStringLiteral("会话 id 非法")},
                                          {QStringLiteral("code"), QStringLiteral("VALIDATION_FAILED")}});
        }
        const QJsonValue levelValue = channels::argAt(args, 1);
        // An empty string/null clears the override; anything else must exist.
        QString levelId;
        if (levelValue.isString()) levelId = levelValue.toString();
        else if (!levelValue.isNull() && !levelValue.isUndefined()) {
            return QJsonValue(QJsonObject{{QStringLiteral("ok"), false},
                                          {QStringLiteral("error"), QStringLiteral("等级 id 不存在")},
                                          {QStringLiteral("code"), QStringLiteral("VALIDATION_FAILED")}});
        }
        return resultJson(security::setSessionLevel(settingsPath(services), snapshotPath(services),
                                                    services.agentDir, sessionValue.toString(),
                                                    levelId));
    });
}
