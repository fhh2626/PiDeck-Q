#pragma once

/**
 * 中间态 → 渲染层视图（纯函数）。
 *
 * today / 本周 / 本月 / 热力图都按传入的 now 现算，所以跨刷新时间漂移是安全的：
 * 缓存里只存中间态，不存「今天」这种会过期的派生值。
 */

#include <QDateTime>
#include <QJsonObject>

#include "UsageTypes.h"

namespace usage {

/** 从中间态派生完整视图。 */
QJsonObject buildAggregatedView(const Intermediate &state, const QDateTime &now);

} // namespace usage
