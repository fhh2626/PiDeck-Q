#pragma once

#include <QJsonValue>

#include <QString>

/**
 * JS coercion helpers for the AI SDK translator.
 *
 * The oracle translates pi payloads with `String(x ?? y ?? "")` and identity checks on
 * structured inputs. Getting `String()` wrong is visible on the wire (a `null` delta
 * would become "null" text), so the small set of coercions lives in one place instead of
 * being re-invented per branch.
 */
namespace webstream {

/** `String(value)`: JS scalar rendering, `""` for null/undefined, JSON text for objects. */
QString jsString(const QJsonValue &value);

/** `a ?? b`: undefined *and* null fall through to the right-hand side. */
QJsonValue coalesce(const QJsonValue &value, const QJsonValue &fallback);

/** Structural equality, used where the oracle compares snapshot inputs. */
bool jsonEqual(const QJsonValue &left, const QJsonValue &right);

} // namespace webstream
