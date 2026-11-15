#include "MessageContent.h"

#include "ImageContent.h"

#include <QJsonObject>
#include <QRegularExpression>

namespace messagecontent {
namespace {

/** CPA uses this final-line sentinel for transport completion; it is not content. */
QString stripCpaCompletionMarker(const QString &text)
{
    static const QRegularExpression marker(QStringLiteral("(?:^|\\r?\\n)<CPA_DONE>\\s*$"));
    QString result = text;
    result.remove(marker);
    return result;
}

} // namespace

QString stripHostInstruction(const QString &text)
{
    if (text.isEmpty()) return QString();
    QString next = text;
    next.replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
    static const QRegularExpression envelope(
        QStringLiteral("\\[PIDECK_HOST_INSTRUCTION\\][\\s\\S]*?\\[/PIDECK_HOST_INSTRUCTION\\]\\s*"));
    next.remove(envelope);
    // Historical sessions already contain the Feishu bridge preamble; strip it too so
    // upgrading does not suddenly expose internal instructions in old history.
    if (next.startsWith(QStringLiteral("当前会话已连接飞书聊天"))) {
        const QStringList parts = next.split(QRegularExpression(QStringLiteral("\n\n+")));
        if (parts.size() >= 2 && parts.first().contains(QStringLiteral("SEND_FILE"))) {
            next = parts.mid(1).join(QStringLiteral("\n\n"));
        }
    }
    static const QRegularExpression feishuGroupSuffix(
        QStringLiteral("\n{0,2}\\[这是飞书群聊消息。请直接回复用户。\\]\\s*$"));
    static const QRegularExpression feishuGroupSuffix2(
        QStringLiteral("\n{0,2}\\[飞书群聊消息。请直接回复用户。\\]\\s*$"));
    static const QRegularExpression feishuCapability(QStringLiteral("\n{0,2}\\[PiDeck 飞书能力\\][\\s\\S]*$"));
    next.remove(feishuGroupSuffix);
    next.remove(feishuGroupSuffix2);
    next.remove(feishuCapability);
    static const QRegularExpression blankRuns(QStringLiteral("\n{3,}"));
    next.replace(blankRuns, QStringLiteral("\n\n"));
    return next.trimmed();
}

QString extractMessageText(const QJsonValue &content)
{
    if (content.isString()) return stripCpaCompletionMarker(stripHostInstruction(content.toString()));
    if (!content.isArray()) return QString();
    QString text;
    for (const QJsonValue &value : content.toArray()) {
        if (value.isString()) {
            text += value.toString();
            continue;
        }
        if (!value.isObject()) continue;
        const QJsonObject block = value.toObject();
        const QString type = block.value(QStringLiteral("type")).toString();
        if (type == QLatin1String("image")) continue;
        if (type == QLatin1String("thinking")) {
            const QString thinking = block.value(QStringLiteral("thinking")).toString();
            if (!thinking.isEmpty()) {
                // Thinking is a separate semantic block; keep it tagged and delimited so
                // it never fuses with the surrounding body text.
                const QString prefix = !text.isEmpty() && !text.endsWith(QLatin1Char('\n'))
                    ? QStringLiteral("\n")
                    : QString();
                text += prefix + QStringLiteral("<thinking>") + thinking + QStringLiteral("</thinking>");
            }
            continue;
        }
        text += block.value(QStringLiteral("text")).toString();
    }
    return stripCpaCompletionMarker(stripHostInstruction(text));
}

QString extractThinkingRaw(const QJsonValue &content)
{
    if (!content.isArray()) return QString();
    QStringList parts;
    for (const QJsonValue &value : content.toArray()) {
        if (!value.isObject()) continue;
        const QJsonObject block = value.toObject();
        if (block.value(QStringLiteral("type")).toString() != QLatin1String("thinking")) continue;
        QString text = block.value(QStringLiteral("thinking")).toString();
        if (text.isEmpty()) text = block.value(QStringLiteral("text")).toString();
        if (!text.isEmpty()) parts.append(text);
    }
    return parts.join(QLatin1Char('\n'));
}

ResendContent extractResendContent(const QJsonValue &content)
{
    ResendContent result;
    if (content.isString()) {
        result.text = content.toString();
        return result;
    }
    if (!content.isArray()) return result;
    QStringList textParts;
    for (const QJsonValue &value : content.toArray()) {
        if (!value.isObject()) continue;
        const QJsonObject block = value.toObject();
        if (block.value(QStringLiteral("type")).toString() != QLatin1String("text")) continue;
        const QJsonValue text = block.value(QStringLiteral("text"));
        if (text.isString()) textParts.append(text.toString());
    }
    result.text = textParts.join(QLatin1Char('\n'));
    result.images = imagecontent::extract(content).images;
    return result;
}

} // namespace messagecontent
