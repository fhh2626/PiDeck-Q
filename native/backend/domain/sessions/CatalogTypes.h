#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

/**
 * Durable session catalog record (session-catalog.json v1).
 *
 * Mirrors SessionCatalogEntry from src/main/sessions/SessionCatalog.ts. Optional
 * fields are represented by explicit `has*` flags because the oracle distinguishes
 * `undefined` (key omitted from JSON) from a present-but-empty value, and that
 * difference is observable in `sessions:catalog-list` output.
 */
struct CatalogEntry {
    QString id;
    QString projectId;
    QString originKey;
    QString title;
    /** Anonymous entries live only in memory and are never written to disk. */
    bool noSession = false;
    QString source = QStringLiteral("pi");
    QString environment = QStringLiteral("native");
    QString filePath;
    QString wslDistro;
    QString wslUser;
    QString importedSourceId;
    /** draft | active */
    QString status = QStringLiteral("active");
    bool hasIsInternalSubagent = false;
    bool isInternalSubagent = false;
    bool hasParentSessionPath = false;
    QString parentSessionPath;
    bool hasScanMetadata = false;
    QJsonObject scanMetadata;
    bool hasModel = false;
    QString modelProvider;
    QString modelId;
    bool hasThinkingLevel = false;
    QString thinkingLevel;
    QString piSessionId;
    qint64 createdAt = 0;
    qint64 updatedAt = 0;
};

namespace catalogjson {

/** Serialize one entry exactly like the oracle's JSON.stringify of the object. */
QJsonObject toJson(const CatalogEntry &entry);
/** Parse one entry; returns false when a required field is missing or invalid. */
bool fromJson(const QJsonObject &value, CatalogEntry *out);

/**
 * Drop unknown keys and clamp values, matching sanitizeScanMetadata.
 * An empty result is returned as a null QJsonValue so callers can omit the key.
 */
QJsonValue sanitizeScanMetadata(const QJsonValue &value);

/** True when two sanitized metadata objects are field-for-field equal. */
bool sameScanMetadata(const QJsonValue &left, const QJsonValue &right);

/** Deep-enough copy (model + scanMetadata are the only nested values). */
CatalogEntry cloneEntry(const CatalogEntry &entry);

} // namespace catalogjson
