#include "AgentTranscript.h"
#include "PiTaskMessage.h"

#include <QCoreApplication>
#include <QFile>
#include <QJsonDocument>
#include <cstdio>

/** Exercise the production projector and live transcript with one JSON fixture. */
int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QFile input;
    if (!input.open(stdin, QIODevice::ReadOnly)) return 1;
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(input.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) return 2;
    const QJsonObject fixture = document.object();
    const QJsonObject task = fixture.value(QStringLiteral("task")).toObject();
    const auto translate = [](const QString &key, const QJsonObject &) { return key; };
    projector::Deps deps;
    deps.translate = translate;
    const QJsonArray projected = projector::convert(QStringLiteral("agent"), {task},
        {QStringLiteral("task-entry")}, {}, deps);
    if (projected.size() != 1) return 3;
    const QJsonObject card = projected.first().toObject();

    agentruntime::Transcript transcript;
    transcript.configure(QStringLiteral("agent"), translate);
    QJsonObject meta{{QStringLiteral("optimisticRequestId"), QStringLiteral("request")},
                     {QStringLiteral("streamingBehavior"), QStringLiteral("followUp")}};
    if (fixture.value(QStringLiteral("noRequestId")).toBool()) meta.remove(QStringLiteral("optimisticRequestId"));
    transcript.appendMessage(QStringLiteral("user"), fixture.value(QStringLiteral("pendingText")).toString(), meta);
    const QJsonObject pending = transcript.messages().first().toObject();
    if (fixture.value(QStringLiteral("interveningMessage")).toBool()) {
        transcript.appendMessage(QStringLiteral("assistant"), QStringLiteral("another turn"), {});
    }
    transcript.appendTodoTask(card.value(QStringLiteral("text")).toString(), card.value(QStringLiteral("meta")).toObject());
    QString goal;
    pitask::readTodoTaskGoal(task, &goal);
    const QJsonObject result{{QStringLiteral("projected"), card},
                             {QStringLiteral("pending"), pending},
                             {QStringLiteral("messages"), transcript.messages()},
                             {QStringLiteral("neutralGoal"), goal}};
    const QByteArray output = QJsonDocument(result).toJson(QJsonDocument::Compact);
    std::fwrite(output.constData(), 1, size_t(output.size()), stdout);
    std::fputc('\n', stdout);
    return 0;
}
