#pragma once

/**
 * 用量聚合的纯函数层：记录 → 中间态，中间态 + 增量中间态 → 合并中间态。
 *
 * 无 IO、无全局状态，便于单测与缓存复用。日键一律按本地时区，因为用户视角的
 * 「一天」是本地日历天，而不是 UTC 天。
 */

#include <QDateTime>
#include <QString>

#include "UsageTypes.h"

namespace usage {

/** 本地时区日键 "YYYY-MM-DD"。 */
QString dayKeyOf(const QDateTime &moment);

/** 扫描记录 → 中间态。 */
Intermediate intermediateFromRecords(const QVector<Record> &records);

/** 合并两个中间态（增量刷新：新段 + 旧缓存），不做重新扫描。 */
Intermediate mergeIntermediates(const Intermediate &base, const Intermediate &delta);

} // namespace usage
