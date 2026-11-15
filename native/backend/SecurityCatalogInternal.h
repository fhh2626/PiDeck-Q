#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

/**
 * Internals shared by the security translation units.
 *
 * `SecurityDefaults.cpp` owns the built-in levels (and the deny pattern lists they
 * reference); `SecurityCatalog.cpp` owns validation, persistence and the snapshot.
 * Nothing here is channel-facing - include SecurityCatalog.h for that.
 */
namespace security {
namespace internal {

/** Tool names a level may assign an action to; anything else is a validation error. */
extern const QStringList kSecurityTools;

/** Default deny patterns for the two shell tools (shared by every non-off level). */
extern const QStringList kDefaultDenyBashPatterns;
extern const QStringList kDefaultDenyPowerShellPatterns;

QJsonArray toArray(const QStringList &values);

/** One built-in level record; `builtin` is always true. */
QJsonObject level(const QString &id, const QString &name, const QString &description,
                  const QJsonObject &toolActions, const QJsonArray &bashPatterns,
                  const QJsonArray &powerShellPatterns, const QString &pathPolicy,
                  bool protectSensitivePaths, const QString &defaultAction);

} // namespace internal
} // namespace security
