#include "ModelThinkingSupport.h"

#include <QJsonObject>

namespace modellist {
namespace {

bool isDeclaredLevel(const QJsonValue &value)
{
    return value.isString() && (value.toString() == QLatin1String("xhigh")
                                || value.toString() == QLatin1String("max"));
}

ThinkingSupport supportFromMap(const QJsonObject &map)
{
    ThinkingSupport support;
    support.xhigh = isDeclaredLevel(map.value(QStringLiteral("xhigh")));
    support.max = isDeclaredLevel(map.value(QStringLiteral("max")));
    return support;
}

QJsonObject supportJson(const ThinkingSupport &support)
{
    return QJsonObject{
        {QStringLiteral("xhigh"), support.xhigh},
        {QStringLiteral("max"), support.max},
    };
}

} // namespace

QString thinkingSupportKey(const QString &provider, const QString &modelId)
{
    return (provider + QChar(0) + modelId).toLower();
}

bool isExtendedThinkingLevel(const QString &level)
{
    return level == QLatin1String("xhigh") || level == QLatin1String("max");
}

QString clampThinkingLevel(const QString &level, const ThinkingSupport &support)
{
    if (level == QLatin1String("xhigh") && !support.xhigh) return QStringLiteral("high");
    if (level == QLatin1String("max") && !support.max) return QStringLiteral("high");
    return level;
}

ThinkingSupportMap collectThinkingSupport(const QJsonValue &parsed)
{
    ThinkingSupportMap support;
    if (!parsed.isObject()) return support;
    const QJsonValue providers = parsed.toObject().value(QStringLiteral("providers"));
    if (!providers.isObject()) return support;
    const QJsonObject providerMap = providers.toObject();
    for (auto provider = providerMap.constBegin(); provider != providerMap.constEnd(); ++provider) {
        if (!provider.value().isObject()) continue;
        const QJsonValue models = provider.value().toObject().value(QStringLiteral("models"));
        if (!models.isArray()) continue;
        for (const QJsonValue &modelValue : models.toArray()) {
            if (!modelValue.isObject()) continue;
            const QJsonObject model = modelValue.toObject();
            const QJsonValue id = model.value(QStringLiteral("id"));
            if (!id.isString() || id.toString().isEmpty()) continue;
            // Explicit `reasoning:false` means pi only offers `off`; a leftover map must
            // not resurrect the extended levels in the picker.
            support.insert(thinkingSupportKey(provider.key(), id.toString()),
                           model.value(QStringLiteral("reasoning")).isBool()
                                   && !model.value(QStringLiteral("reasoning")).toBool()
                               ? ThinkingSupport{}
                               : supportFromMap(model.value(QStringLiteral("thinkingLevelMap")).toObject()));
        }
    }
    return support;
}

QJsonArray applyThinkingSupport(const QJsonArray &models, const ThinkingSupportMap &support)
{
    QJsonArray result;
    for (const QJsonValue &value : models) {
        if (!value.isObject()) {
            result.append(value);
            continue;
        }
        QJsonObject model = value.toObject();
        const QJsonValue reasoning = model.value(QStringLiteral("reasoning"));
        const bool reasoningDisabled = reasoning.isBool() && !reasoning.toBool();
        const ThinkingSupport levels = reasoningDisabled
            ? ThinkingSupport{}
            : support.value(thinkingSupportKey(model.value(QStringLiteral("provider")).toString(),
                                              model.value(QStringLiteral("id")).toString()));
        model.insert(QStringLiteral("thinkingLevels"), supportJson(levels));
        result.append(model);
    }
    return result;
}

} // namespace modellist
