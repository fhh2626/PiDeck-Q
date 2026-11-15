#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

#include <functional>

/**
 * Delivery budget for message payloads and history pages.
 *
 * Port of src/main/pi/messageDeliveryBudget.ts. A session with many images can exceed the
 * 32 MiB native frame limit; the transport then drops the frame and the renderer silently
 * loses the whole transcript. The budget degrades instead: strip duplicated tool payloads,
 * then offload images one *message* at a time (`slideOut` before `messages`) and attach a
 * `delivery-budget-exceeded` notice so the UI can show "N images omitted".
 *
 * The measurement is on the *envelope*, not the payload: the wrapper adds identity fields
 * and JSON escaping that can push a payload just under the limit over it. Callers pass the
 * exact wrapper they are about to send.
 *
 * Per-message granularity is part of the contract: the oracle stops offloading as soon as
 * the envelope fits again, so the newest messages keep their images whenever the older
 * ones alone were enough to get under budget.
 */
namespace deliverybudget {

/** 30 MiB: leaves headroom under the 32 MiB native frame cap. */
constexpr qint64 kMaxEnvelopeBytes = 30 * 1024 * 1024;

struct Outcome {
    /** Best-effort payload: stripped tool results, plus every image offloaded so far. */
    QJsonObject value;
    /** False when even the fully stripped envelope does not fit; the caller must not send. */
    bool ok = true;
    /** `MESSAGE_DELIVERY_TOO_LARGE` (or `SERIALIZATION_FAILED`) when `ok` is false. */
    QString code;
};

/** Builds the complete wire envelope around a candidate payload, for measurement. */
using Wrapper = std::function<QJsonObject(const QJsonObject &)>;

/**
 * Remove `meta.result` / `partialResult` / `output` from tool messages.
 *
 * The result already exists as compact text in `text`; the raw object is only needed by
 * the main process and doubles the frame size. Exposed because history pages must strip
 * unconditionally, even when they fit the budget (oracle `enforceDeliveryBudgetOnPage`).
 */
QJsonArray stripToolResultsForDelivery(const QJsonArray &messages);

/** `enforceDeliveryBudgetOnPayload`: degrade a live message payload before sending. */
Outcome enforcePayload(const QJsonObject &payload, const Wrapper &wrap,
                       qint64 maxBytes = kMaxEnvelopeBytes);

/** `enforceDeliveryBudgetOnPage`: `{ok:true,result:page}` envelope, images offloaded. */
Outcome enforcePage(const QJsonObject &page, qint64 maxBytes = kMaxEnvelopeBytes);

/**
 * Budget override for tests (`PIDECK_MESSAGE_DELIVERY_BUDGET_BYTES`), clamped to a sane
 * range so a malformed value cannot disable the protection.
 */
qint64 configuredMaxBytes();

} // namespace deliverybudget
