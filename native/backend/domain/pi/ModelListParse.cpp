#include "ModelListParse.h"

#include <QJsonObject>
#include <QRegularExpression>
#include <QSet>

#include <cmath>

namespace modellist {
namespace {

QString stringValue(const QJsonValue &value)
{
    if (!value.isString()) return QString();
    const QString trimmed = value.toString().trimmed();
    return trimmed.isEmpty() ? QString() : trimmed;
}

bool isYesNo(const QString &value)
{
    return value.compare(QLatin1String("yes"), Qt::CaseInsensitive) == 0
        || value.compare(QLatin1String("no"), Qt::CaseInsensitive) == 0;
}

QString dedupeKey(const QString &provider, const QString &modelId)
{
    return (provider + QChar(0) + modelId).toLower();
}

void insertTokenSize(QJsonObject *model, const QString &key, const QString &cell)
{
    qint64 bytes = 0;
    if (parseTokenSize(cell, &bytes)) model->insert(key, double(bytes));
}

} // namespace

bool parseTokenSize(const QString &value, qint64 *bytes)
{
    const QString trimmed = value.trimmed();
    if (trimmed.isEmpty()) return false;
    static const QRegularExpression pattern(QStringLiteral("^([\\d.]+)([KkMm])?$"));
    const QRegularExpressionMatch match = pattern.match(trimmed);
    if (!match.hasMatch()) return false;
    bool numeric = false;
    const double number = match.captured(1).toDouble(&numeric);
    if (!numeric || !std::isfinite(number) || number <= 0) return false;
    const QString unit = match.captured(2).toLower();
    if (unit == QLatin1String("k")) {
        *bytes = qint64(std::llround(number * 1024.0));
    } else if (unit == QLatin1String("m")) {
        *bytes = qint64(std::llround(number * 1024.0 * 1024.0));
    } else {
        *bytes = qint64(std::llround(number));
    }
    return true;
}

QJsonArray normalizeRpcModels(const QJsonValue &data)
{
    QJsonArray models;
    if (!data.isObject()) return models;
    const QJsonValue list = data.toObject().value(QStringLiteral("models"));
    if (!list.isArray()) return models;

    QSet<QString> seen;
    for (const QJsonValue &item : list.toArray()) {
        if (!item.isObject()) continue;
        const QJsonObject raw = item.toObject();
        const QString provider = stringValue(raw.value(QStringLiteral("provider")));
        QString id = stringValue(raw.value(QStringLiteral("id")));
        if (id.isEmpty()) id = stringValue(raw.value(QStringLiteral("modelId")));
        if (provider.isEmpty() || id.isEmpty()) continue;
        const QString key = dedupeKey(provider, id);
        if (seen.contains(key)) continue;
        seen.insert(key);

        const QJsonValue inputValue = raw.value(QStringLiteral("input"));
        const QJsonArray input = inputValue.isArray() ? inputValue.toArray() : QJsonArray();
        bool inputHasImage = false;
        for (const QJsonValue &capability : input) {
            if (capability.isString() && capability.toString() == QLatin1String("image")) {
                inputHasImage = true;
                break;
            }
        }
        const bool hasImagesFlag = raw.value(QStringLiteral("images")).isBool();
        const bool images = hasImagesFlag ? raw.value(QStringLiteral("images")).toBool() : inputHasImage;
        const bool hasImageCapability = hasImagesFlag || !input.isEmpty();

        QJsonObject model{
            {QStringLiteral("provider"), provider},
            {QStringLiteral("id"), id},
            {QStringLiteral("name"),
             stringValue(raw.value(QStringLiteral("name"))).isEmpty()
                 ? QStringLiteral("%1/%2").arg(provider, id)
                 : stringValue(raw.value(QStringLiteral("name")))},
        };
        for (const char *key : {"contextWindow", "maxTokens"}) {
            const QJsonValue value = raw.value(QLatin1String(key));
            if (value.isDouble() && std::isfinite(value.toDouble()) && value.toDouble() > 0) {
                model.insert(QLatin1String(key), value.toDouble());
            }
        }
        const QJsonValue reasoning = raw.value(QStringLiteral("reasoning"));
        if (reasoning.isBool()) model.insert(QStringLiteral("reasoning"), reasoning.toBool());
        if (hasImageCapability) model.insert(QStringLiteral("images"), images);
        models.append(model);
    }
    return models;
}

QJsonArray parseTextModels(const QString &output)
{
    QStringList lines;
    for (const QString &raw : output.split(QLatin1Char('\n'))) {
        QString line = raw;
        if (line.endsWith(QLatin1Char('\r'))) line.chop(1);
        line = line.trimmed();
        if (!line.isEmpty()) lines.append(line);
    }
    if (lines.size() < 2) return {};

    static const QRegularExpression header(QStringLiteral("^provider\\s+model\\b"),
                                           QRegularExpression::CaseInsensitiveOption);
    int headerIndex = -1;
    for (int index = 0; index < lines.size(); ++index) {
        if (header.match(lines.at(index)).hasMatch()) {
            headerIndex = index;
            break;
        }
    }
    static const QRegularExpression whitespace(QStringLiteral("\\s+"));
    static const QRegularExpression showing(QStringLiteral("^showing$"),
                                            QRegularExpression::CaseInsensitiveOption);
    QStringList dataLines = lines.mid(headerIndex >= 0 ? headerIndex + 1 : 1);

    QJsonArray models;
    QSet<QString> seen;
    for (const QString &line : dataLines) {
        const QStringList parts = line.split(whitespace, Qt::SkipEmptyParts);
        if (parts.size() < 3) continue;
        if (showing.match(parts.first()).hasMatch()) continue;

        QString provider;
        QString modelId;
        QJsonObject model;
        if (parts.size() >= 6) {
            const QStringList tail = parts.mid(parts.size() - 4);
            if (!isYesNo(tail.at(2)) || !isYesNo(tail.at(3))) continue;
            provider = parts.mid(0, parts.size() - 5).join(QLatin1Char(' '));
            modelId = parts.at(parts.size() - 5);
            if (provider.isEmpty() || modelId.isEmpty()) continue;
            model.insert(QStringLiteral("reasoning"), tail.at(2).compare(QLatin1String("yes"), Qt::CaseInsensitive) == 0);
            model.insert(QStringLiteral("images"), tail.at(3).compare(QLatin1String("yes"), Qt::CaseInsensitive) == 0);
            insertTokenSize(&model, QStringLiteral("contextWindow"), tail.at(0));
            insertTokenSize(&model, QStringLiteral("maxTokens"), tail.at(1));
        } else {
            // Legacy `provider model thinking` rows.
            const QString thinking = parts.last();
            if (!isYesNo(thinking)) continue;
            provider = parts.mid(0, parts.size() - 2).join(QLatin1Char(' '));
            modelId = parts.at(parts.size() - 2);
            if (provider.isEmpty() || modelId.isEmpty()) continue;
            model.insert(QStringLiteral("reasoning"),
                         thinking.compare(QLatin1String("yes"), Qt::CaseInsensitive) == 0);
        }
        const QString key = dedupeKey(provider, modelId);
        if (seen.contains(key)) continue;
        seen.insert(key);
        QJsonObject entry{
            {QStringLiteral("provider"), provider},
            {QStringLiteral("id"), modelId},
            {QStringLiteral("name"), QStringLiteral("%1/%2").arg(provider, modelId)},
        };
        for (auto iterator = model.constBegin(); iterator != model.constEnd(); ++iterator) {
            entry.insert(iterator.key(), iterator.value());
        }
        models.append(entry);
    }
    return models;
}

} // namespace modellist
