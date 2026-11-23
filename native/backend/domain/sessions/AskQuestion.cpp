#include "AskQuestion.h"

#include <QJsonArray>
#include <QJsonDocument>

namespace askquestion {
namespace {

QJsonObject asObject(const QJsonValue &value)
{
    return value.isObject() ? value.toObject() : QJsonObject{};
}

QJsonObject parseArgs(const QJsonValue &args)
{
    if (args.isObject()) return args.toObject();
    if (!args.isString() || args.toString().trimmed().isEmpty()) return QJsonObject{};
    const QJsonDocument document = QJsonDocument::fromJson(args.toString().toUtf8());
    return document.isObject() ? document.object() : QJsonObject{};
}

bool looksLikeAsk(const QJsonObject &value)
{
    if (!value.isEmpty() && value.value(QStringLiteral("question")).isString()
        && !value.value(QStringLiteral("question")).toString().isEmpty()) {
        return true;
    }
    return value.value(QStringLiteral("questions")).isArray()
        || value.value(QStringLiteral("answers")).isArray();
}

QString normalizeType(const QJsonValue &value)
{
    if (!value.isString()) return QString();
    const QString type = value.toString();
    if (type == QLatin1String("select") || type == QLatin1String("confirm")
        || type == QLatin1String("input") || type == QLatin1String("editor")) {
        return type;
    }
    return QString();
}

QJsonArray normalizeOptions(const QJsonValue &value)
{
    QJsonArray options;
    if (!value.isArray()) return options;
    for (const QJsonValue &entry : value.toArray()) {
        if (entry.isString() && !entry.toString().isEmpty()) {
            options.append(entry);
            continue;
        }
        if (!entry.isObject()) continue;
        const QJsonObject object = entry.toObject();
        const QJsonValue label = object.value(QStringLiteral("label"));
        if (!label.isString() || label.toString().isEmpty()) continue;
        QJsonObject option{{QStringLiteral("label"), label}};
        if (object.contains(QStringLiteral("value"))) option.insert(QStringLiteral("value"), object.value(QStringLiteral("value")));
        const QJsonValue description = object.value(QStringLiteral("description"));
        if (description.isString() && !description.toString().isEmpty()) {
            option.insert(QStringLiteral("description"), description);
        }
        options.append(option);
    }
    return options;
}

Item normalizeItem(const QJsonObject &raw)
{
    Item item;
    const QJsonValue question = raw.value(QStringLiteral("question"));
    if (!question.isString() || question.toString().trimmed().isEmpty()) return item;
    item.question = question.toString();
    const bool hasAnswer = raw.contains(QStringLiteral("answer"));
    item.answer = hasAnswer ? raw.value(QStringLiteral("answer")) : QJsonValue(QJsonValue::Null);
    item.answered = raw.value(QStringLiteral("answered")).isBool()
        ? raw.value(QStringLiteral("answered")).toBool()
        : (hasAnswer && !item.answer.isNull() && !item.answer.isUndefined());
    item.type = normalizeType(raw.value(QStringLiteral("type")));
    const QJsonValue label = raw.value(QStringLiteral("answerLabel"));
    if (label.isString() && !label.toString().isEmpty()) item.answerLabel = label.toString();
    item.options = normalizeOptions(raw.value(QStringLiteral("options")));
    item.valid = true;
    return item;
}

QVector<Item> normalizeBatchItems(const QJsonValue &questionsRaw, const QJsonValue &answersRaw)
{
    const QJsonArray questions = questionsRaw.isArray() ? questionsRaw.toArray() : QJsonArray{};
    const QJsonArray answers = answersRaw.isArray() ? answersRaw.toArray() : QJsonArray{};
    const int length = qMax(questions.size(), answers.size());
    QVector<Item> items;
    for (int index = 0; index < length; ++index) {
        const QJsonValue questionRaw = index < questions.size() ? questions.at(index) : QJsonValue();
        const QJsonValue answerRaw = index < answers.size() ? answers.at(index) : QJsonValue();
        Item item;
        if (questionRaw.isObject()) {
            item = normalizeItem(questionRaw.toObject());
        } else if (answerRaw.isObject()) {
            item = normalizeItem(answerRaw.toObject());
        }
        if (!item.valid && answerRaw.isObject()) {
            const QJsonValue id = answerRaw.toObject().value(QStringLiteral("id"));
            const QString idText = id.isString() ? id.toString()
                : (id.isUndefined() || id.isNull() ? QString() : QString::number(id.toDouble()));
            item = normalizeItem(QJsonObject{{QStringLiteral("question"), idText}});
        }
        if (!item.valid) continue;
        if (answerRaw.isObject()) {
            const QJsonObject answer = answerRaw.toObject();
            if (answer.contains(QStringLiteral("value"))) {
                item.answer = answer.value(QStringLiteral("value"));
                if (item.answer.isUndefined()) item.answer = QJsonValue(QJsonValue::Null);
            }
            const QJsonValue label = answer.value(QStringLiteral("label"));
            if (label.isString() && !label.toString().isEmpty()) item.answerLabel = label.toString();
            if (answer.value(QStringLiteral("answered")).isBool()) {
                item.answered = answer.value(QStringLiteral("answered")).toBool();
            } else {
                item.answered = !item.answer.isNull() && !item.answer.isUndefined();
            }
        } else if (answerRaw.isString() || answerRaw.isBool() || answerRaw.isDouble()) {
            // Old/third-party ask implementations return scalar answers; `false` and `0`
            // are valid answers, so a truthiness test would mislabel batch confirms.
            item.answer = answerRaw;
            item.answered = true;
        }
        items.append(item);
    }
    return items;
}

} // namespace

Summary build(const QString &toolName, const QJsonValue &args, const QJsonValue &result, bool aborted,
              bool isError)
{
    Summary summary;
    if (toolName.toLower() != QLatin1String("ask_question")) return summary;
    // An errored ask returns error prose, not a user answer. Promoting it would render
    // a "answered" card with the error text as the answer.
    if (isError && !aborted) return summary;

    QJsonObject details;
    const QJsonObject resultObject = asObject(result);
    if (resultObject.contains(QStringLiteral("details"))
        && looksLikeAsk(asObject(resultObject.value(QStringLiteral("details"))))) {
        details = asObject(resultObject.value(QStringLiteral("details")));
    }
    if (details.isEmpty() && looksLikeAsk(resultObject)) details = resultObject;

    // Scalar / unrecognized result: recover the question from args. Only when a result
    // actually arrived, otherwise a running call would already show a card.
    if (details.isEmpty() && !result.isUndefined() && !result.isNull()) {
        const QJsonObject parsedArgs = parseArgs(args);
        const QJsonValue question = parsedArgs.value(QStringLiteral("question"));
        if (question.isString() && !question.toString().isEmpty()) {
            QJsonValue answer;
            if (result.isString() || result.isBool()) {
                answer = result;
            } else if (result.isObject()) {
                const QJsonObject object = result.toObject();
                answer = object.contains(QStringLiteral("value")) ? object.value(QStringLiteral("value"))
                                                                 : object.value(QStringLiteral("answer"));
            }
            const bool hasAnswer = !answer.isUndefined() && !answer.isNull();
            if (hasAnswer || aborted) {
                QJsonObject built{{QStringLiteral("question"), question}};
                const QString type = normalizeType(parsedArgs.value(QStringLiteral("type")));
                if (!type.isEmpty()) built.insert(QStringLiteral("type"), type);
                if (parsedArgs.value(QStringLiteral("options")).isArray()) {
                    built.insert(QStringLiteral("options"), parsedArgs.value(QStringLiteral("options")));
                }
                built.insert(QStringLiteral("answer"), hasAnswer ? answer : QJsonValue(QJsonValue::Null));
                built.insert(QStringLiteral("answered"), hasAnswer);
                if (answer.isString()) built.insert(QStringLiteral("answerLabel"), answer);
                details = built;
            }
        } else if (parsedArgs.value(QStringLiteral("questions")).isArray()) {
            QJsonObject built{{QStringLiteral("questions"), parsedArgs.value(QStringLiteral("questions"))}};
            if (result.isArray()) built.insert(QStringLiteral("answers"), result);
            details = built;
        }
    }
    if (details.isEmpty()) return summary;

    const bool cancelled = details.value(QStringLiteral("cancelled")).toBool(false) || aborted;
    const bool wasBatch = details.value(QStringLiteral("questions")).isArray()
        || details.value(QStringLiteral("answers")).isArray();
    QVector<Item> items;
    if (wasBatch) {
        items = normalizeBatchItems(details.value(QStringLiteral("questions")),
                                    details.value(QStringLiteral("answers")));
    }
    if (items.isEmpty()) {
        const Item single = normalizeItem(details);
        if (single.valid) items.append(single);
    }
    if (items.isEmpty()) return summary;

    summary.cancelled = cancelled;
    for (Item item : items) {
        if (cancelled) {
            // A cancelled ask must not display the extension's default first option as
            // if the user picked it.
            item.answered = false;
            item.answer = QJsonValue(QJsonValue::Null);
            item.answerLabel.clear();
        }
        summary.items.append(item);
    }
    summary.valid = true;
    return summary;
}

QJsonObject toJson(const Summary &summary)
{
    if (!summary.valid || summary.items.isEmpty()) return QJsonObject{};
    const Item &first = summary.items.first();
    QJsonObject card{
        {QStringLiteral("question"), first.question},
        {QStringLiteral("answered"), first.answered},
        {QStringLiteral("answer"), first.answer},
        {QStringLiteral("cancelled"), summary.cancelled},
    };
    if (!first.type.isEmpty()) card.insert(QStringLiteral("type"), first.type);
    if (!first.answerLabel.isEmpty()) card.insert(QStringLiteral("answerLabel"), first.answerLabel);
    if (!first.options.isEmpty()) card.insert(QStringLiteral("options"), first.options);
    if (summary.items.size() > 1) {
        QJsonArray questions;
        for (const Item &item : summary.items) {
            QJsonObject entry{
                {QStringLiteral("question"), item.question},
                {QStringLiteral("answered"), item.answered},
                {QStringLiteral("answer"), item.answer},
            };
            if (!item.type.isEmpty()) entry.insert(QStringLiteral("type"), item.type);
            if (!item.answerLabel.isEmpty()) entry.insert(QStringLiteral("answerLabel"), item.answerLabel);
            if (!item.options.isEmpty()) entry.insert(QStringLiteral("options"), item.options);
            questions.append(entry);
        }
        card.insert(QStringLiteral("questions"), questions);
    }
    return card;
}

} // namespace askquestion
