#include "ConfigFiles.h"

#include "JsonFile.h"

#include <algorithm>

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QRegularExpression>
#include <QStringList>

namespace configfiles {
namespace {

QString filePath(const QString &configDir, const QString &fileName)
{
    return QDir(configDir).filePath(fileName);
}

QString docsUrlFor(const QString &fileName)
{
    if (fileName == QStringLiteral("models.json")) return QStringLiteral("https://pi.dev/docs/latest/models");
    if (fileName == QStringLiteral("settings.json")) return QStringLiteral("https://pi.dev/docs/latest/settings");
    return QStringLiteral("https://pi.dev/docs/latest/providers");
}

/**
 * Turn a parse failure into the diagnostic the config dialog shows.
 *
 * The oracle parses the position out of V8's message text; Qt reports an offset
 * directly, so the line/column/snippet are derived from it. The message text itself is
 * the parser's own wording (documented divergence: it is not byte-identical to V8's).
 */
QJsonObject createDiagnostic(const QString &fileName, const QString &raw, const QJsonParseError &error)
{
    QJsonObject diagnostic{
        {QStringLiteral("fileName"), fileName},
        {QStringLiteral("message"), error.errorString()},
        {QStringLiteral("docsUrl"), docsUrlFor(fileName)},
    };
    const int position = error.offset;
    if (position >= 0 && position <= raw.size()) {
        const QString before = raw.left(position);
        const QStringList lines = before.split(QRegularExpression(QStringLiteral("\\r?\\n")));
        const int line = lines.size();
        const int column = lines.isEmpty() ? 1 : lines.last().size() + 1;
        const QStringList rawLines = raw.split(QRegularExpression(QStringLiteral("\\r?\\n")));
        const int start = std::max(0, line - 2);
        const int end = std::min(int(rawLines.size()), line + 1);
        QStringList snippet;
        for (int index = start; index < end; ++index) {
            snippet.append(QStringLiteral("%1: %2").arg(index + 1).arg(rawLines.at(index)));
        }
        diagnostic.insert(QStringLiteral("line"), line);
        diagnostic.insert(QStringLiteral("column"), column);
        diagnostic.insert(QStringLiteral("snippet"), snippet.join(QLatin1Char('\n')));
    }
    return diagnostic;
}

bool writeFile(const QString &configDir, const QString &fileName, const QString &text, QString *error)
{
    if (!QDir().mkpath(configDir)) {
        if (error) *error = QStringLiteral("Unable to create %1").arg(configDir);
        return false;
    }
    return jsonfile::writeBytesAtomic(filePath(configDir, fileName), text.toUtf8(), error);
}

QJsonObject normalizeModelsForPi(const QJsonObject &data)
{
    QJsonObject result = data;
    QJsonObject providers;
    const QJsonObject source = data.value(QStringLiteral("providers")).toObject();
    for (auto iterator = source.begin(); iterator != source.end(); ++iterator) {
        QJsonObject provider = iterator.value().toObject();
        provider.insert(QStringLiteral("api"),
                        normalizeApiType(provider.value(QStringLiteral("api")).toString()));
        QJsonArray models;
        for (const QJsonValue &value : provider.value(QStringLiteral("models")).toArray()) {
            QJsonObject model = value.toObject();
            // A per-model api override is normalized too, otherwise pi rejects the entry.
            const QJsonValue api = model.value(QStringLiteral("api"));
            if (api.isString()) model.insert(QStringLiteral("api"), normalizeApiType(api.toString()));
            models.append(model);
        }
        provider.insert(QStringLiteral("models"), models);
        providers.insert(iterator.key(), provider);
    }
    result.insert(QStringLiteral("providers"), providers);
    return result;
}

Validation validateModels(const QJsonValue &data, const maincopy::Translator &t)
{
    const QJsonValue providers = data.toObject().value(QStringLiteral("providers"));
    if (!providers.isObject()) {
        return Validation{false, t(QStringLiteral("mainConfig.modelsProvidersRequired"), {}), {}};
    }
    const QJsonObject providerObject = providers.toObject();
    for (auto iterator = providerObject.begin(); iterator != providerObject.end(); ++iterator) {
        const QJsonValue models = iterator.value().toObject().value(QStringLiteral("models"));
        if (!models.isArray()) {
            return Validation{false,
                              t(QStringLiteral("mainConfig.providerModelsRequired"),
                                QJsonObject{{QStringLiteral("provider"), iterator.key()}}),
                              {}};
        }
        const QJsonArray array = models.toArray();
        for (int index = 0; index < array.size(); ++index) {
            const QJsonValue id = array.at(index).toObject().value(QStringLiteral("id"));
            if (!id.isString() || id.toString().isEmpty()) {
                return Validation{false,
                                  t(QStringLiteral("mainConfig.modelIdRequired"),
                                    QJsonObject{{QStringLiteral("provider"), iterator.key()},
                                                {QStringLiteral("index"), index + 1}}),
                                  {}};
            }
        }
    }
    return Validation{true, {}, {}};
}

} // namespace

QString normalizeApiType(const QString &apiType)
{
    if (apiType == QStringLiteral("anthropic") || apiType == QStringLiteral("anthropic-messages")) {
        return QStringLiteral("anthropic-messages");
    }
    if (apiType == QStringLiteral("openai-codex-responses")) return QStringLiteral("openai-codex-responses");
    // Early PiDeck builds exposed this alias; pi's registry name is openai-completions.
    if (apiType == QStringLiteral("openai-chat-completions")) return QStringLiteral("openai-completions");
    if (apiType == QStringLiteral("openai-completions") || apiType == QStringLiteral("openai-responses")
        || apiType == QStringLiteral("google-generative-ai")
        || apiType == QStringLiteral("mistral-conversations")) {
        return apiType;
    }
    return QStringLiteral("openai-completions");
}

FileRead read(const QString &configDir, const QString &fileName, const QJsonValue &fallback)
{
    FileRead result;
    const QString path = filePath(configDir, fileName);
    QFile file(path);
    if (!file.exists()) {
        result.raw = QString::fromUtf8(jsonfile::prettyJson(fallback));
        result.parsed = fallback;
        return result;
    }
    if (!file.open(QIODevice::ReadOnly)) {
        // A permission/IO failure is not "no configuration": the caller must be able to
        // distinguish it from a fresh install.
        result.raw = QString::fromUtf8(jsonfile::prettyJson(fallback));
        result.parsed = fallback;
        result.readError = true;
        return result;
    }
    result.raw = QString::fromUtf8(file.readAll());
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(result.raw.toUtf8(), &error);
    if (error.error != QJsonParseError::NoError) {
        // Keep the raw text so the Raw editor can still open and repair the file.
        result.parsed = fallback;
        result.hasDiagnostic = true;
        result.diagnostic = createDiagnostic(fileName, result.raw, error);
        return result;
    }
    result.parsed = document.isArray() ? QJsonValue(document.array()) : QJsonValue(document.object());
    return result;
}

Validation saveModels(const QString &configDir, const QJsonValue &data, const maincopy::Translator &t)
{
    if (!data.isObject()) return Validation{false, t(QStringLiteral("mainConfig.modelsProvidersRequired"), {}), {}};
    const Validation validation = validateModels(data, t);
    if (!validation.valid) return validation;
    QString error;
    const QJsonObject normalized = normalizeModelsForPi(data.toObject());
    if (!jsonfile::writeJsonAtomic(filePath(configDir, QStringLiteral("models.json")), normalized, &error)) {
        return Validation{false, error, {}};
    }
    return Validation{true, {}, {}};
}

Validation saveSettings(const QString &configDir, const QJsonValue &data)
{
    QString error;
    if (!jsonfile::writeJsonAtomic(filePath(configDir, QStringLiteral("settings.json")), data, &error)) {
        return Validation{false, error, {}};
    }
    return Validation{true, {}, {}};
}

Validation saveRaw(const QString &configDir, const QString &fileName, const QString &rawJson,
                   const maincopy::Translator &t)
{
    QJsonParseError error;
    QJsonDocument::fromJson(rawJson.toUtf8(), &error);
    if (error.error != QJsonParseError::NoError) {
        return Validation{false, t(QStringLiteral("mainConfig.invalidJson"), {}), error.errorString()};
    }
    static const QStringList allowed = {
        QStringLiteral("models.json"),
        QStringLiteral("settings.json"),
    };
    if (!allowed.contains(fileName)) {
        return Validation{false,
                          t(QStringLiteral("mainConfig.fileNotEditable"),
                            QJsonObject{{QStringLiteral("fileName"), fileName}}),
                          {}};
    }
    QString writeError;
    // The raw text is written as typed: re-serializing would destroy the user's formatting.
    if (!writeFile(configDir, fileName, rawJson, &writeError)) {
        return Validation{false, writeError, {}};
    }
    return Validation{true, {}, {}};
}

QString exportPackage(const QString &configDir)
{
    const FileRead models = read(configDir, QStringLiteral("models.json"),
                                 QJsonObject{{QStringLiteral("providers"), QJsonObject{}}});
    const FileRead settings = read(configDir, QStringLiteral("settings.json"), QJsonObject{});
    const QJsonObject package{
        {QStringLiteral("version"), 1},
        {QStringLiteral("exportedAt"),
         QDateTime::currentDateTimeUtc().toString(QStringLiteral("yyyy-MM-ddTHH:mm:ss.zzzZ"))},
        {QStringLiteral("files"),
         QJsonObject{
             {QStringLiteral("models.json"), models.parsed},
             {QStringLiteral("settings.json"), settings.parsed},
         }},
    };
    return QString::fromUtf8(jsonfile::prettyJson(package));
}

Validation importPackage(const QString &configDir, const QString &packageJson,
                         const maincopy::Translator &t)
{
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(packageJson.toUtf8(), &error);
    if (error.error != QJsonParseError::NoError) {
        return Validation{false, t(QStringLiteral("mainConfig.invalidJson"), {}), error.errorString()};
    }
    const QJsonValue files = document.object().value(QStringLiteral("files"));
    if (!files.isObject()) {
        return Validation{false, t(QStringLiteral("mainConfig.importFilesRequired"), {}), {}};
    }
    const QJsonObject fileObject = files.toObject();
    // Only model/settings files are restored. Legacy packages may include auth.json,
    // but credentials remain owned by Pi and must never be overwritten here.
    for (const QString &name : {QStringLiteral("models.json"),
                                QStringLiteral("settings.json")}) {
        const QJsonValue value = fileObject.value(name);
        if (value.isUndefined() || value.isNull()) continue;
        QString writeError;
        if (!jsonfile::writeJsonAtomic(filePath(configDir, name), value, &writeError)) {
            return Validation{false, writeError, {}};
        }
    }
    return Validation{true, {}, {}};
}

} // namespace configfiles
