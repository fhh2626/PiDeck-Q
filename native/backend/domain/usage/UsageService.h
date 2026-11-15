#pragma once

/**
 * 用量统计服务：探测 / 增量刷新 / 查询聚合视图。
 *
 * 数据源 = `<agentDir>/analytics/usage.jsonl`（pi-tracker 扩展写入，append-only）。
 *
 * 缓存两层：
 *  - 内存态（权威）：连续刷新走增量合并，代价 O(新增行)
 *  - 磁盘 `usage-stats-cache.json`：冷启动零 IO 恢复中间态
 *
 * 磁盘缓存文件与 Node 侧 `SessionSummaryCache` 共用同一份格式
 * （`{version, entries: {<logPath>: {version: {mtimeMs,size}, value}}}`），因此
 * 两种 runtime 交替启动时不会互相判为损坏，也不会丢缓存。
 *
 * 错误语义：文件不存在 = 「未安装」；其他 IO 失败一律抛结构化错误，不吞成「无数据」。
 */

#include <QDateTime>
#include <QJsonObject>
#include <QString>

#include "UsageLogReader.h"
#include "UsageTypes.h"

namespace usage {

class Service {
public:
    Service(QString userDataDir, QString agentDir);

    /** WSL 环境后置配置：装配层传入 host 路径。 */
    void setAgentDir(const QString &agentDir);

    QString logPath() const;

    /** 探测日志状态（轻量：只 stat + 读缓存，不触发全量读）。 */
    QJsonObject detect();

    /** 增量刷新：返回本次解析统计；缓存已最新时零 IO。 */
    QJsonObject refresh();

    /** 查询聚合视图；未缓存/过期时先刷新。文件不存在返回 null 对象。 */
    QJsonObject getAggregated();

private:
    struct MemoryState {
        bool valid = false;
        FileState fileState;
        Intermediate intermediate;
    };

    /** stat 日志文件；不存在返回 false（= 未安装），其他错误抛出。 */
    bool statLog(qint64 *size, double *mtimeMs) const;

    /** 加载与版本一致的状态：内存优先，其次磁盘。 */
    bool loadState(qint64 size, double mtimeMs, MemoryState *out);

    void commitState(qint64 size, double mtimeMs, const FileState &fileState,
                     const Intermediate &intermediate);

    void loadDiskCache();
    void saveDiskCache();

    QString m_userDataDir;
    QString m_agentDir;
    MemoryState m_memory;
    /** 磁盘缓存是否已尝试加载（只做一次）。 */
    bool m_diskLoaded = false;
    /** 磁盘缓存条目：logPath → 中间态（与 Node 的 entries 结构一致）。 */
    QJsonObject m_diskEntries;
};

} // namespace usage
