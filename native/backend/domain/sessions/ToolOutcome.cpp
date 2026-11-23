#include "ToolOutcome.h"

namespace tooloutcome {

const char *const kUnknown = "unknown";
const char *const kDone = "done";
const char *const kError = "error";
const char *const kRunning = "running";

QString normalize(const QString &raw)
{
    if (raw == QLatin1String(kRunning) || raw == QLatin1String(kError) || raw == QLatin1String(kUnknown)) {
        return raw;
    }
    return QLatin1String(kDone);
}

} // namespace tooloutcome

namespace imagebudget {

Result apply(const QJsonArray &images, qint64 turnUsedBytes)
{
    Result result;
    if (images.isEmpty()) return result;
    QJsonArray valid;
    int oversized = 0;
    for (const QJsonValue &value : images) {
        const QJsonObject image = value.toObject();
        const qint64 length = image.value(QStringLiteral("data")).toString().size();
        if (length > kMaxSingleBytes) {
            ++oversized;
            continue;
        }
        valid.append(value);
    }
    qint64 used = turnUsedBytes;
    int budgetExceeded = 0;
    for (const QJsonValue &value : valid) {
        if (result.images.size() >= kMaxImages) {
            ++budgetExceeded;
            continue;
        }
        const qint64 length = value.toObject().value(QStringLiteral("data")).toString().size();
        if (used + length > kMaxTotalBytes) {
            ++budgetExceeded;
            continue;
        }
        result.images.append(value);
        used += length;
    }
    if (oversized > 0) {
        result.hasNotice = true;
        result.noticeKind = QStringLiteral("too-large");
        result.noticeCount = images.size();
        result.noticeOmitted = oversized + budgetExceeded;
    } else if (budgetExceeded > 0) {
        result.hasNotice = true;
        result.noticeKind = QStringLiteral("too-many");
        result.noticeCount = images.size();
        result.noticeOmitted = budgetExceeded;
    }
    return result;
}

} // namespace imagebudget
