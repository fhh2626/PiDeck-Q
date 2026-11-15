#pragma once

#include "MainCopy.h"

#include <QByteArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>

/**
 * LAN web response copy and public-payload serialization.
 *
 * The web client localizes by `code`; `error` is the server's English fallback. Only a
 * few strings are ever rendered without JavaScript (the unauthorized page), so this
 * table holds the `webError.*` subset of WebI18n.ts rather than the whole web UI
 * dictionary — the browser bundle ships its own copy.
 */
namespace webcopy {

/** English fallback for a `webError.*` key; `webError.internal` for unknown keys. */
QString errorEn(const QString &key);

/** Chinese text for the same key (only the unauthorized page needs it today). */
QString errorZh(const QString &key);

/**
 * Whole `webError.*` table for one locale, sorted by key.
 *
 * The embedded client page localizes API failures by `payload.code`, so it needs the
 * table, not one lookup. Shares `maincopy::Locale` so the page dictionary can merge it
 * with the main-process copy without a second locale enum.
 */
QJsonObject entries(maincopy::Locale locale);

/** Static bilingual 401 page served to a browser without a token (no user input). */
QByteArray unauthorizedPageHtml();

/**
 * `serializePublicWebPayload`: drop `debugDetails`/`stack` anywhere in the tree and
 * replace `error` on objects carrying an `i18nKey` with the English copy.
 *
 * This is a leak guard, not formatting: a domain error may embed a filesystem path or a
 * stack in `debugDetails`, and a LAN client must never see either.
 */
QJsonValue serializePublic(const QJsonValue &value);

} // namespace webcopy
