#pragma once

#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <functional>

/**
 * Main-process copy (port of src/shared/i18n/mainProcessCopy.ts).
 *
 * User-visible backend strings must follow the desktop language setting, exactly like
 * the Node sidecar. Only the keys this backend actually emits are carried here; a
 * missing key returns the key itself so a gap is visible instead of silently English.
 */
namespace maincopy {

enum class Locale { ZhCN, EnUS };

/** `"en*"` → EnUS, everything else → ZhCN (mirrors normalizeMainProcessLocale). */
Locale normalizeLocale(const QString &locale);

/** Resolve from a settings `language` value, falling back to the system locale. */
Locale resolveLocale(const QString &language);

/** Resolve from a settings object (`language` key). */
Locale resolveLocale(const QJsonObject &settings);

/**
 * Wire tag for the resolved locale (`zh-CN` / `en-US`).
 *
 * `PIDECK_UI_LANGUAGE` carries the *resolved* BCP-47 tag, not the raw settings value:
 * built-in extensions map only `en*` to English, so forwarding `system`/`pseudo`
 * verbatim would silently render Chinese on an English desktop (oracle
 * `currentMainProcessLocale` -> `AgentManager.platformDeps.getLocale`).
 */
QString localeTag(Locale locale);

/** `{name}` interpolation, identical to mainProcessT. */
QString translate(Locale locale, const QString &key, const QJsonObject &params = QJsonObject{});

/**
 * One-call form used by the file/git channel modules: `language` is the raw settings
 * value (`"system"` / `"zh-CN"` / `"en-US"` / `"pseudo"`).
 */
QString text(const QString &language, const QString &key, const QJsonObject &params = QJsonObject{});

using Translator = std::function<QString(const QString &key, const QJsonObject &params)>;

Translator makeTranslator(Locale locale);
Translator makeTranslator(const QString &language);

/** Built-in commit-message prompt for the resolved language. */
QString defaultGitCommitMessagePrompt(const QString &language);

/** Key list, so tests can assert no emitted key is missing from a table. */
QStringList keys();

/**
 * Whole table for one locale, sorted by key.
 *
 * Needed by the LAN web client: it localizes message descriptors (`meta.i18nKey`) in the
 * browser, so it must carry every key this backend can emit — not just the ones a
 * single call site resolves. Sorted so the serialized page is byte-stable instead of
 * following `QHash`'s per-process seed.
 */
QJsonObject entries(Locale locale);

} // namespace maincopy
