#include "SubagentSettings.h"

#include "JsonFile.h"

#include "../../process/TextEncoding.h"

#include <QDir>
#include <QJsonDocument>
#include <QSet>
#include <QStringList>

namespace subagents {
namespace {

/** Thinking levels the extension's parseThinkingLevel accepts. */
const QSet<QString> &thinkingLevels()
{
    static const QSet<QString> levels = {
        QStringLiteral("off"),   QStringLiteral("minimal"), QStringLiteral("low"),
        QStringLiteral("medium"), QStringLiteral("high"),   QStringLiteral("xhigh"),
        QStringLiteral("max"),
    };
    return levels;
}

QString nonEmpty(const QJsonValue &value)
{
    if (!value.isString()) return {};
    const QString trimmed = value.toString().trimmed();
    return trimmed;
}

QString settingsPath(const QString &dir)
{
    return QDir(dir).filePath(QStringLiteral("settings.json"));
}

QJsonObject readSettingsFile(const QString &path)
{
    QJsonValue value;
    const jsonfile::ReadState state = jsonfile::readJson(path, &value, nullptr);
    if (state == jsonfile::ReadState::Missing) return {};
    // A permission or JSON error must surface: treating it as "no configuration" would
    // write an empty file over the user's real settings.
    if (state != jsonfile::ReadState::Ok) {
        throw textenc::error(
            QStringLiteral("Unable to read settings file: %1").arg(path));
    }
    return value.toObject();
}

/** `bareModelId`: strip the provider prefix the renderer does not need to see. */
QString bareModelId(const QString &model, const QString &provider)
{
    const QString prefix = provider.isEmpty() ? QString() : provider + QLatin1Char('/');
    if (!prefix.isEmpty() && model.startsWith(prefix)) return model.mid(prefix.size());
    return model;
}

QJsonObject readBlock(const QJsonObject &settings)
{
    const QJsonValue blockValue = settings.value(QStringLiteral("subagents"));
    if (!blockValue.isObject()) {
        return QJsonObject{{QStringLiteral("useOwnModel"), false},
                           {QStringLiteral("preferDelegation"), false}};
    }
    const QJsonObject block = blockValue.toObject();
    const QString rawModelId = nonEmpty(block.value(QStringLiteral("defaultModel")));
    const QString provider = nonEmpty(block.value(QStringLiteral("defaultProvider")));
    const QString modelId = rawModelId.isEmpty() ? QString() : bareModelId(rawModelId, provider);
    const QString thinking = nonEmpty(block.value(QStringLiteral("defaultThinking")));

    QJsonObject result;
    // `defaultModel` is the only signal that a separate model is configured: a provider
    // without a model still inherits the main agent's model.
    result.insert(QStringLiteral("useOwnModel"), !modelId.isEmpty());
    if (!modelId.isEmpty()) {
        QJsonObject model{
            {QStringLiteral("provider"), provider},
            {QStringLiteral("modelId"), modelId},
        };
        if (!thinking.isEmpty()) model.insert(QStringLiteral("thinkingLevel"), thinking);
        result.insert(QStringLiteral("model"), model);
    }
    result.insert(QStringLiteral("preferDelegation"),
                  block.value(QStringLiteral("preferDelegation")).toBool(false));
    return result;
}

/** Validate the renderer payload; throws so nothing is written on invalid input. */
QJsonObject validate(const QJsonValue &value)
{
    if (!value.isObject()) throw std::runtime_error("subagents settings must be an object");
    const QJsonObject raw = value.toObject();
    if (!raw.value(QStringLiteral("useOwnModel")).isBool()) {
        throw std::runtime_error("useOwnModel must be a boolean");
    }
    if (!raw.value(QStringLiteral("preferDelegation")).isBool()) {
        throw std::runtime_error("preferDelegation must be a boolean");
    }
    QJsonObject model;
    if (raw.contains(QStringLiteral("model")) && !raw.value(QStringLiteral("model")).isNull()) {
        const QJsonValue modelValue = raw.value(QStringLiteral("model"));
        if (!modelValue.isObject()) throw std::runtime_error("model must be an object");
        const QJsonObject modelObject = modelValue.toObject();
        const QString modelId = nonEmpty(modelObject.value(QStringLiteral("modelId")));
        if (modelId.isEmpty()) {
            throw std::runtime_error("model.modelId must be a non-empty string");
        }
        const QString provider = nonEmpty(modelObject.value(QStringLiteral("provider")));
        const QString thinking = nonEmpty(modelObject.value(QStringLiteral("thinkingLevel")));
        if (!thinking.isEmpty() && !thinkingLevels().contains(thinking)) {
            throw textenc::error(
                QStringLiteral("model.thinkingLevel must be one of %1")
                    .arg(QStringList(thinkingLevels().begin(), thinkingLevels().end())
                             .join(QStringLiteral(", ")))
                    );
        }
        model.insert(QStringLiteral("provider"), provider);
        model.insert(QStringLiteral("modelId"), modelId);
        if (!thinking.isEmpty()) model.insert(QStringLiteral("thinkingLevel"), thinking);
    }
    // "Own model" without a model would silently write a configuration that never applies.
    if (raw.value(QStringLiteral("useOwnModel")).toBool() && model.isEmpty()) {
        throw std::runtime_error("model is required when useOwnModel is true");
    }
    QJsonObject result{{QStringLiteral("useOwnModel"), raw.value(QStringLiteral("useOwnModel"))},
                       {QStringLiteral("preferDelegation"),
                        raw.value(QStringLiteral("preferDelegation"))}};
    if (!model.isEmpty()) result.insert(QStringLiteral("model"), model);
    return result;
}

QJsonObject apply(const QJsonObject &settings, const QJsonObject &next)
{
    QJsonObject base = settings;
    QJsonObject block = settings.value(QStringLiteral("subagents")).toObject();
    // Whether the file already had a model configuration decides if turning the switch
    // off clears the three model keys: a hand-written defaultProvider must survive a save
    // that only touched `preferDelegation`.
    const bool hadOwnModel = block.contains(QStringLiteral("defaultModel"));

    const QJsonObject model = next.value(QStringLiteral("model")).toObject();
    const QString modelId = model.value(QStringLiteral("modelId")).toString();
    if (next.value(QStringLiteral("useOwnModel")).toBool() && !modelId.isEmpty()) {
        const QString provider = model.value(QStringLiteral("provider")).toString();
        // A model id that already contains a slash (OpenRouter's `anthropic/...`) must be
        // written fully qualified, otherwise the extension resolves a different provider.
        block.insert(QStringLiteral("defaultModel"),
                     provider.isEmpty() ? modelId : provider + QLatin1Char('/') + modelId);
        if (!provider.isEmpty()) block.insert(QStringLiteral("defaultProvider"), provider);
        else block.remove(QStringLiteral("defaultProvider"));
        const QString thinking = model.value(QStringLiteral("thinkingLevel")).toString();
        if (!thinking.isEmpty()) block.insert(QStringLiteral("defaultThinking"), thinking);
        else block.remove(QStringLiteral("defaultThinking"));
    } else if (hadOwnModel) {
        block.remove(QStringLiteral("defaultModel"));
        block.remove(QStringLiteral("defaultProvider"));
        block.remove(QStringLiteral("defaultThinking"));
    }

    if (next.value(QStringLiteral("preferDelegation")).toBool()) {
        block.insert(QStringLiteral("preferDelegation"), true);
    } else {
        block.remove(QStringLiteral("preferDelegation"));
    }
    if (block.isEmpty()) base.remove(QStringLiteral("subagents"));
    else base.insert(QStringLiteral("subagents"), block);
    return base;
}

} // namespace

QJsonObject read(const QString &agentDir, const QString &projectPath)
{
    const QJsonObject global = readBlock(readSettingsFile(settingsPath(agentDir)));
    QJsonValue project(QJsonValue::Null);
    if (!projectPath.isEmpty()) {
        project = readBlock(readSettingsFile(
            QDir(projectPath).filePath(QStringLiteral(".pi/settings.json"))));
    }
    return QJsonObject{
        {QStringLiteral("global"), global},
        {QStringLiteral("project"), project},
    };
}

void save(const QString &agentDir, const QString &projectPath, const QString &scope,
          const QJsonValue &settings)
{
    const QJsonObject next = validate(settings);
    QString path;
    if (scope == QStringLiteral("global")) {
        path = settingsPath(agentDir);
    } else if (scope == QStringLiteral("project")) {
        if (projectPath.isEmpty()) throw std::runtime_error("project settings require a known project");
        path = QDir(projectPath).filePath(QStringLiteral(".pi/settings.json"));
    } else {
        throw std::runtime_error("scope must be \"global\" or \"project\"");
    }
    const QJsonObject merged = apply(readSettingsFile(path), next);
    QString error;
    // pi reads this file at startup, so a half-written file would break the next launch.
    if (!jsonfile::writeJsonAtomic(path, merged, &error)) {
        throw textenc::error(error);
    }
}

} // namespace subagents
