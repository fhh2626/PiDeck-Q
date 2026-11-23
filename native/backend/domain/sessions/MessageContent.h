#pragma once

#include <QJsonArray>
#include <QJsonValue>
#include <QString>

/**
 * pi content-block → display text (port of src/main/pi/messageContent.ts).
 *
 * Two behaviours matter for parity:
 *  - host instructions injected by PiDeck are stripped before display, otherwise the
 *    internal prompt leaks into history;
 *  - sibling `{type:"text"}` blocks are concatenated **without** separators. Some
 *    Anthropic-compatible providers split one sentence into many blocks, and joining
 *    with newlines turned Chinese answers into one fragment per line.
 */
namespace messagecontent {

QString extractMessageText(const QJsonValue &content);
QString extractThinkingRaw(const QJsonValue &content);

/** Resend payload: text plus any valid images. */
struct ResendContent {
    QString text;
    QJsonArray images;
};
ResendContent extractResendContent(const QJsonValue &content);

/** Strip PiDeck's internal host-instruction envelope from user-visible text. */
QString stripHostInstruction(const QString &text);

} // namespace messagecontent
