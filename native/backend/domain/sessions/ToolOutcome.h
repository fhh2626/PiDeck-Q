#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>

/**
 * Display budgets and tool-outcome vocabulary shared by the projector and pager.
 *
 * A tool call whose result never reached the file must never claim success, failure
 * or a duration: `unknown` is the only honest status, and the renderer keys its
 * "result not recorded" card off exactly that value.
 */
namespace tooloutcome {

extern const char *const kUnknown;
extern const char *const kDone;
extern const char *const kError;
extern const char *const kRunning;

/** Legacy records without a status fall back to done (the historical default). */
QString normalize(const QString &raw);

} // namespace tooloutcome

namespace imagebudget {

/** Per-image base64 cap (4 MiB). */
constexpr qint64 kMaxSingleBytes = 4 * 1024 * 1024;
/** Per-message image count cap. */
constexpr int kMaxImages = 8;
/** Per-turn aggregate base64 cap (8 MiB). */
constexpr qint64 kMaxTotalBytes = 8 * 1024 * 1024;

struct Result {
    QJsonArray images;
    bool hasNotice = false;
    QString noticeKind;
    int noticeCount = 0;
    int noticeOmitted = 0;
};

/**
 * Apply the display budget: drop oversized images, then cap count and per-turn bytes.
 * `turnUsedBytes` is carried across messages of the same turn by the caller.
 */
Result apply(const QJsonArray &images, qint64 turnUsedBytes);

} // namespace imagebudget
