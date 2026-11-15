#include "DeliveryBudget.h"

#include <QJsonDocument>
#include <QJsonValue>

namespace deliverybudget {
namespace {

/**
 * `Buffer.byteLength(JSON.stringify(value), "utf8")`.
 *
 * Qt always produces UTF-8 here and cannot fail the way `JSON.stringify` does (cycles,
 * BigInt), so the oracle's `SERIALIZATION_FAILED` branch is unreachable from this side;
 * callers still get `ok == false` for the over-budget case, which is the one that can
 * actually happen.
 */
qint64 envelopeBytes(const QJsonObject &value)
{
    return QJsonDocument(value).toJson(QJsonDocument::Compact).size();
}

/** One stripped tool message, or the input value when nothing needed removing. */
QJsonValue stripToolMessage(const QJsonValue &value, bool *changed)
{
    if (!value.isObject()) return value;
    const QJsonObject message = value.toObject();
    if (message.value(QStringLiteral("role")).toString() != QLatin1String("tool")) return value;
    QJsonValue metaValue = message.value(QStringLiteral("meta"));
    if (!metaValue.isObject()) return value;
    QJsonObject meta = metaValue.toObject();
    bool stripped = false;
    for (const QString &key : {QStringLiteral("result"), QStringLiteral("partialResult"),
                               QStringLiteral("output")}) {
        if (meta.contains(key)) {
            meta.remove(key);
            stripped = true;
        }
    }
    if (!stripped) return value;
    *changed = true;
    QJsonObject copy = message;
    copy.insert(QStringLiteral("meta"), meta);
    return copy;
}

/**
 * Replace one message's images with the oracle's notice.
 *
 * The notice object is *replaced*, not merged: the oracle builds
 * `{kind,count,omitted}` from scratch, so a stale extra key would change the wire bytes.
 * `count` keeps the first notice's total (the number of images the message ever had),
 * `omitted` accumulates, which is what the timeline renders as "N images omitted".
 */
QJsonValue offloadMessageImages(const QJsonValue &value, bool *changed)
{
    if (!value.isObject()) return value;
    const QJsonObject message = value.toObject();
    const QJsonArray images = message.value(QStringLiteral("images")).toArray();
    if (images.isEmpty()) return value;
    *changed = true;
    const QJsonObject notice = message.value(QStringLiteral("imageDisplayNotice")).toObject();
    const int previousOmitted = notice.value(QStringLiteral("omitted")).toInt(0);
    const int count = notice.contains(QStringLiteral("count"))
                          ? notice.value(QStringLiteral("count")).toInt()
                          : images.size();
    QJsonObject copy = message;
    copy.remove(QStringLiteral("images"));
    copy.insert(QStringLiteral("imageDisplayNotice"),
                QJsonObject{
                    {QStringLiteral("kind"), QStringLiteral("delivery-budget-exceeded")},
                    {QStringLiteral("count"), count},
                    {QStringLiteral("omitted"), previousOmitted + images.size()},
                });
    return copy;
}

/** Strip tool results in copy-on-write fashion; `changed` tells the caller it differs. */
QJsonArray stripAll(const QJsonArray &messages, bool *changed)
{
    QJsonArray out;
    for (const QJsonValue &value : messages) out.append(stripToolMessage(value, changed));
    return out;
}

QJsonArray arrayOrEmpty(const QJsonObject &object, const QString &key)
{
    const QJsonValue value = object.value(key);
    return value.isArray() ? value.toArray() : QJsonArray{};
}

} // namespace

QJsonArray stripToolResultsForDelivery(const QJsonArray &messages)
{
    bool changed = false;
    return stripAll(messages, &changed);
}

Outcome enforcePayload(const QJsonObject &payload, const Wrapper &wrap, qint64 maxBytes)
{
    Outcome outcome;
    outcome.value = payload;

    // 1. Tool results are duplicated by `text`; strip both arrays before measuring.
    bool changed = false;
    QJsonArray slideOut;
    const bool hasSlideOut = payload.value(QStringLiteral("slideOut")).isArray();
    if (hasSlideOut) slideOut = stripAll(arrayOrEmpty(payload, QStringLiteral("slideOut")), &changed);
    QJsonArray messages = stripAll(arrayOrEmpty(payload, QStringLiteral("messages")), &changed);
    QJsonObject current = payload;
    current.insert(QStringLiteral("messages"), messages);
    if (hasSlideOut) current.insert(QStringLiteral("slideOut"), slideOut);

    qint64 bytes = envelopeBytes(wrap(current));
    if (bytes <= maxBytes) {
        outcome.value = current;
        return outcome;
    }

    // 2. Offload `slideOut` first: it holds the oldest messages the user scrolled past.
    for (int index = 0; hasSlideOut && index < slideOut.size(); ++index) {
        bool offloaded = false;
        const QJsonValue next = offloadMessageImages(slideOut.at(index), &offloaded);
        if (!offloaded) continue;
        slideOut.replace(index, next);
        current.insert(QStringLiteral("slideOut"), slideOut);
        if (envelopeBytes(wrap(current)) <= maxBytes) {
            outcome.value = current;
            return outcome;
        }
    }

    // 3. Then the live messages, oldest first: the tail is what the user is looking at,
    //    so the oracle stops as soon as the envelope fits again.
    for (int index = 0; index < messages.size(); ++index) {
        bool offloaded = false;
        const QJsonValue next = offloadMessageImages(messages.at(index), &offloaded);
        if (!offloaded) continue;
        messages.replace(index, next);
        current.insert(QStringLiteral("messages"), messages);
        if (envelopeBytes(wrap(current)) <= maxBytes) {
            outcome.value = current;
            return outcome;
        }
    }

    outcome.value = current;
    outcome.ok = false;
    outcome.code = QStringLiteral("MESSAGE_DELIVERY_TOO_LARGE");
    return outcome;
}

Outcome enforcePage(const QJsonObject &page, qint64 maxBytes)
{
    Outcome outcome;
    QJsonObject stripped = page;
    stripped.insert(QStringLiteral("messages"),
                    stripToolResultsForDelivery(arrayOrEmpty(page, QStringLiteral("messages"))));
    const Wrapper wrap = [](const QJsonObject &candidate) {
        return QJsonObject{{QStringLiteral("ok"), true},
                           {QStringLiteral("result"), candidate}};
    };

    qint64 bytes = envelopeBytes(wrap(stripped));
    if (bytes <= maxBytes) {
        outcome.value = stripped;
        return outcome;
    }

    QJsonArray messages = arrayOrEmpty(stripped, QStringLiteral("messages"));
    QJsonObject current = stripped;
    for (int index = 0; index < messages.size(); ++index) {
        bool offloaded = false;
        const QJsonValue next = offloadMessageImages(messages.at(index), &offloaded);
        if (!offloaded) continue;
        messages.replace(index, next);
        current.insert(QStringLiteral("messages"), messages);
        if (envelopeBytes(wrap(current)) <= maxBytes) {
            outcome.value = current;
            return outcome;
        }
    }

    outcome.value = current;
    outcome.ok = false;
    outcome.code = QStringLiteral("MESSAGE_DELIVERY_TOO_LARGE");
    return outcome;
}

qint64 configuredMaxBytes()
{
    static const qint64 configured = []() {
        const QString raw = qEnvironmentVariable("PIDECK_MESSAGE_DELIVERY_BUDGET_BYTES").trimmed();
        if (raw.isEmpty()) return kMaxEnvelopeBytes;
        bool ok = false;
        const qint64 value = raw.toLongLong(&ok);
        if (!ok) return kMaxEnvelopeBytes;
        // Tests downscale the budget to exercise offload/blocked paths with small
        // fixtures; the production value must stay the 30 MiB contract, so a larger
        // override would silently disable the guard.
        return qBound<qint64>(256, value, kMaxEnvelopeBytes);
    }();
    return configured;
}

} // namespace deliverybudget
