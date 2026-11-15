#pragma once

#include <QJsonArray>
#include <QJsonValue>
#include <QString>

/**
 * Structured image extraction from pi content blocks (port of src/shared/imageContent.ts).
 *
 * Invalid blocks are counted, not silently dropped: the caller can distinguish "no
 * images" from "images that failed validation", which is what the display notice
 * needs. Only PNG/JPEG/GIF/WebP base64 payloads are accepted.
 */
namespace imagecontent {

struct Extraction {
    QJsonArray images;
    int invalidCount = 0;
};

Extraction extract(const QJsonValue &content);

/** True for a well-formed standard base64 string (no base64url, no data URL). */
bool isValidBase64(const QString &value);

} // namespace imagecontent
