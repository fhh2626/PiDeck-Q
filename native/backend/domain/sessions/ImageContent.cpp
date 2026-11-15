#include "ImageContent.h"

#include <QJsonObject>
#include <QSet>

namespace imagecontent {
namespace {

const QSet<QString> &supportedMimeTypes()
{
    static const QSet<QString> types{
        QStringLiteral("image/png"), QStringLiteral("image/jpeg"), QStringLiteral("image/gif"),
        QStringLiteral("image/webp"),
    };
    return types;
}

/** Returns the normalized MIME type, or an empty string when it is invalid. */
QString normalizeMimeType(const QJsonValue &raw, bool *valid)
{
    *valid = true;
    if (raw.isUndefined()) return QStringLiteral("image/png");
    if (!raw.isString() || raw.toString().trimmed().isEmpty()) {
        *valid = false;
        return QString();
    }
    const QString normalized = raw.toString().trimmed().toLower();
    if (!supportedMimeTypes().contains(normalized)) {
        *valid = false;
        return QString();
    }
    return normalized;
}

} // namespace

bool isValidBase64(const QString &value)
{
    if (value.isEmpty() || value.size() % 4 != 0) return false;
    int padding = 0;
    if (value.endsWith(QLatin1String("=="))) {
        padding = 2;
    } else if (value.endsWith(QLatin1Char('='))) {
        padding = 1;
    }
    const int dataLength = value.size() - padding;
    for (int index = 0; index < dataLength; ++index) {
        const QChar character = value.at(index);
        const ushort code = character.unicode();
        const bool upper = code >= 'A' && code <= 'Z';
        const bool lower = code >= 'a' && code <= 'z';
        const bool digit = code >= '0' && code <= '9';
        const bool plus = character == QLatin1Char('+');
        const bool slash = character == QLatin1Char('/');
        if (!upper && !lower && !digit && !plus && !slash) return false;
    }
    return true;
}

Extraction extract(const QJsonValue &content)
{
    Extraction result;
    if (!content.isArray()) return result;
    for (const QJsonValue &value : content.toArray()) {
        if (!value.isObject()) continue;
        const QJsonObject block = value.toObject();
        if (block.value(QStringLiteral("type")).toString() != QLatin1String("image")) continue;

        QJsonValue data = block.value(QStringLiteral("data"));
        QJsonValue mime = block.contains(QStringLiteral("mimeType"))
            ? block.value(QStringLiteral("mimeType"))
            : block.value(QStringLiteral("mime_type"));

        // Nested form: {type:"image", source:{type:"base64", data, media_type}}.
        if ((data.isUndefined() || data.isNull()) && block.value(QStringLiteral("source")).isObject()) {
            const QJsonObject source = block.value(QStringLiteral("source")).toObject();
            if (source.value(QStringLiteral("type")).toString() == QLatin1String("base64")) {
                data = source.value(QStringLiteral("data"));
                mime = source.contains(QStringLiteral("mimeType"))
                    ? source.value(QStringLiteral("mimeType"))
                    : source.value(QStringLiteral("media_type"));
            }
        }
        if (!data.isString() || data.toString().trimmed().isEmpty()) {
            ++result.invalidCount;
            continue;
        }
        const QString clean = data.toString().trimmed();
        if (!isValidBase64(clean)) {
            ++result.invalidCount;
            continue;
        }
        bool mimeValid = true;
        const QString mimeType = normalizeMimeType(mime, &mimeValid);
        if (!mimeValid) {
            ++result.invalidCount;
            continue;
        }
        result.images.append(QJsonObject{
            {QStringLiteral("type"), QStringLiteral("image")},
            {QStringLiteral("data"), clean},
            {QStringLiteral("mimeType"), mimeType},
        });
    }
    return result;
}

} // namespace imagecontent
