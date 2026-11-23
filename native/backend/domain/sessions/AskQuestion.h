#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QSet>
#include <QString>
#include <QVector>

/**
 * ask_question result → AskQuestionResultSummary (port of src/main/pi/askQuestionResult.ts
 * plus src/shared/askQuestion.ts).
 *
 * The live runtime and the history projector share this builder so the same tool
 * result produces the same card whether the session is running or replayed from disk.
 */
namespace askquestion {

struct Item {
    bool valid = false;
    QString question;
    bool answered = false;
    QJsonValue answer;
    QString type;
    QString answerLabel;
    QJsonArray options;
};

struct Summary {
    bool valid = false;
    bool cancelled = false;
    QVector<Item> items;
};

/**
 * Build the canonical card. `isError` gates the "error text promoted to answer"
 * failure mode; `aborted` overrides to cancelled-unanswered.
 */
Summary build(const QString &toolName, const QJsonValue &args, const QJsonValue &result, bool aborted,
              bool isError);

/** Serialize to the `_askCard` meta object. */
QJsonObject toJson(const Summary &summary);

} // namespace askquestion
