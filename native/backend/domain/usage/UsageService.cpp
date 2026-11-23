#include "UsageService.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>

#include "UsageBuckets.h"
#include "UsageView.h"

#include "../fs/JsonFile.h"

namespace usage {
namespace {

/** 缓存结构版本：与 Node 侧 CACHE_SCHEMA_VERSION 保持一致，否则会互相判为过期。 */
constexpr int kCacheSchemaVersion = 3;
/** 磁盘缓存文件版本（SessionSummaryCache 的 DISK_SCHEMA_VERSION）。 */
constexpr int kDiskSchemaVersion = 4;
constexpr qint64 kMaxLogBytes = kDefaultMaxLogBytes;

QString cacheFilePath(const QString &userDataDir)
{
    return QDir(userDataDir).filePath(QStringLiteral("usage-stats-cache.json"));
}

bool versionEqual(const FileState &state, qint64 size, double mtimeMs)
{
    return state.size == size && qFuzzyCompare(state.mtimeMs + 1.0, mtimeMs + 1.0);
}

} // namespace

Service::Service(QString userDataDir, QString agentDir)
    : m_userDataDir(std::move(userDataDir))
    , m_agentDir(std::move(agentDir))
{
}

void Service::setAgentDir(const QString &agentDir)
{
    if (agentDir == m_agentDir) return;
    m_agentDir = agentDir;
    // 换目录：内存态失效（磁盘缓存按 logPath 隔离，天然不串数据）。
    m_memory = MemoryState{};
}

QString Service::logPath() const
{
    return logPathFor(m_agentDir);
}

bool Service::statLog(qint64 *size, double *mtimeMs) const
{
    const QFileInfo info(logPath());
    if (!info.exists() || !info.isFile()) return false;
    *size = info.size();
    *mtimeMs = static_cast<double>(info.lastModified().toMSecsSinceEpoch());
    return true;
}

void Service::loadDiskCache()
{
    if (m_diskLoaded) return;
    m_diskLoaded = true;

    QFile file(cacheFilePath(m_userDataDir));
    if (!file.open(QIODevice::ReadOnly)) return;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll());
    if (!document.isObject()) return;
    const QJsonObject root = document.object();
    if (root.value(QStringLiteral("version")).toInt() != kDiskSchemaVersion) return;
    const QJsonValue entries = root.value(QStringLiteral("entries"));
    if (!entries.isObject()) return;
    m_diskEntries = entries.toObject();
}

void Service::saveDiskCache()
{
    const QString path = cacheFilePath(m_userDataDir);
    QDir().mkpath(QFileInfo(path).absolutePath());
    QJsonObject root{
        {QStringLiteral("version"), kDiskSchemaVersion},
        {QStringLiteral("entries"), m_diskEntries},
    };
    // 原子写：缓存损坏只意味着下次慢一点，绝不能影响主流程。走共享的`writeBytesAtomic`
    // 以获得 Windows 瞬态 rename 锁（EPERM/EBUSY）退避重试，不再单独用 QSaveFile。
    QString ignored;
    jsonfile::writeBytesAtomic(path, QJsonDocument(root).toJson(QJsonDocument::Compact), &ignored);
}

bool Service::loadState(qint64 size, double mtimeMs, MemoryState *out)
{
    if (m_memory.valid && versionEqual(m_memory.fileState, size, mtimeMs)) {
        *out = m_memory;
        return true;
    }

    loadDiskCache();
    const QJsonObject entry = m_diskEntries.value(logPath()).toObject();
    if (entry.isEmpty()) return false;
    const QJsonObject version = entry.value(QStringLiteral("version")).toObject();
    const double entryMtime = version.value(QStringLiteral("mtimeMs")).toDouble();
    const qint64 entrySize = static_cast<qint64>(version.value(QStringLiteral("size")).toDouble());
    if (!qFuzzyCompare(entryMtime + 1.0, mtimeMs + 1.0) || entrySize != size) {
        // 版本不匹配：旧条目作废（Node 侧同样会删除），触发全量重扫。
        m_diskEntries.remove(logPath());
        saveDiskCache();
        return false;
    }

    const QJsonObject value = entry.value(QStringLiteral("value")).toObject();
    // 结构版本不匹配：旧缓存弃用，避免缺字段的中间态被增量合并。
    if (value.value(QStringLiteral("schemaVersion")).toInt() != kCacheSchemaVersion) return false;

    MemoryState state;
    state.valid = true;
    state.fileState.size = entrySize;
    state.fileState.mtimeMs = entryMtime;
    const QJsonObject fileState = value.value(QStringLiteral("fileState")).toObject();
    state.fileState.ino = static_cast<quint64>(fileState.value(QStringLiteral("ino")).toDouble());
    state.fileState.hasIno = fileState.contains(QStringLiteral("ino"));
    state.fileState.count = static_cast<qint64>(
        fileState.value(QStringLiteral("count")).toDouble());
    state.intermediate = Intermediate::fromJson(
        value.value(QStringLiteral("intermediate")).toObject());
    m_memory = state;
    *out = state;
    return true;
}

void Service::commitState(qint64 size, double mtimeMs, const FileState &fileState,
                          const Intermediate &intermediate)
{
    m_memory.valid = true;
    m_memory.fileState = fileState;
    m_memory.fileState.size = size;
    m_memory.fileState.mtimeMs = mtimeMs;
    m_memory.intermediate = intermediate;

    QJsonObject value{
        {QStringLiteral("schemaVersion"), kCacheSchemaVersion},
        {QStringLiteral("fileState"),
         QJsonObject{
             {QStringLiteral("size"), fileState.size},
             {QStringLiteral("mtimeMs"), fileState.mtimeMs},
             {QStringLiteral("ino"), static_cast<double>(fileState.ino)},
             {QStringLiteral("count"), static_cast<double>(fileState.count)},
         }},
        {QStringLiteral("intermediate"), intermediate.toJson()},
    };
    m_diskEntries.insert(logPath(), QJsonObject{
        {QStringLiteral("version"),
         QJsonObject{
             {QStringLiteral("mtimeMs"), mtimeMs},
             {QStringLiteral("size"), size},
         }},
        {QStringLiteral("value"), value},
    });
    saveDiskCache();
}

QJsonObject Service::detect()
{
    qint64 size = 0;
    double mtimeMs = 0;
    if (!statLog(&size, &mtimeMs)) {
        return QJsonObject{
            {QStringLiteral("installed"), false},
            {QStringLiteral("logPath"), QJsonValue::Null},
            {QStringLiteral("recordCount"), QJsonValue::Null},
            {QStringLiteral("firstRecordAt"), QJsonValue::Null},
            {QStringLiteral("lastRecordAt"), QJsonValue::Null},
        };
    }

    MemoryState state;
    if (!loadState(size, mtimeMs, &state)) {
        return QJsonObject{
            {QStringLiteral("installed"), true},
            {QStringLiteral("logPath"), logPath()},
            {QStringLiteral("recordCount"), QJsonValue::Null},
            {QStringLiteral("firstRecordAt"), QJsonValue::Null},
            {QStringLiteral("lastRecordAt"), QJsonValue::Null},
        };
    }
    const bool hasData = state.intermediate.recordCount > 0;
    return QJsonObject{
        {QStringLiteral("installed"), true},
        {QStringLiteral("logPath"), logPath()},
        {QStringLiteral("recordCount"), state.intermediate.recordCount},
        {QStringLiteral("firstRecordAt"), hasData ? QJsonValue(state.intermediate.windowSince)
                                                  : QJsonValue(QJsonValue::Null)},
        {QStringLiteral("lastRecordAt"), hasData ? QJsonValue(state.intermediate.windowTo)
                                                 : QJsonValue(QJsonValue::Null)},
    };
}

QJsonObject Service::refresh()
{
    const QJsonObject unchanged{
        {QStringLiteral("fullRescan"), false},
        {QStringLiteral("parsedRecords"), 0},
        {QStringLiteral("skippedLines"), 0},
    };

    qint64 size = 0;
    double mtimeMs = 0;
    if (!statLog(&size, &mtimeMs)) return unchanged;

    MemoryState state;
    if (loadState(size, mtimeMs, &state)) return unchanged; // 已最新

    // 未命中：旧游标只能来自内存态（磁盘命中版本不匹配时已删除旧条目）。
    const bool hasPrevious = m_memory.valid;
    const ReadResult result = readIncremental(
        logPath(), hasPrevious ? &m_memory.fileState : nullptr, kMaxLogBytes);
    if (!result.hasFileState) return unchanged;

    if (result.fullRescan) {
        // 全量重扫：无论新记录多少都整体替换。0 条 = 文件被清空，必须提交空态，
        // 否则旧中间态会在新版本下复活，文件再长回来时会被增量合并成双计。
        commitState(size, mtimeMs, result.fileState,
                    intermediateFromRecords(result.newRecords));
    } else if (!result.newRecords.isEmpty()) {
        const Intermediate delta = intermediateFromRecords(result.newRecords);
        const Intermediate merged = m_memory.valid
            ? mergeIntermediates(m_memory.intermediate, delta)
            : delta;
        commitState(size, mtimeMs, result.fileState, merged);
    } else if (m_memory.valid) {
        // 文件变了但没有新记录（如 mtime 抖动）：仅更新游标。
        commitState(size, mtimeMs, result.fileState, m_memory.intermediate);
    }

    return QJsonObject{
        {QStringLiteral("fullRescan"), result.fullRescan},
        {QStringLiteral("parsedRecords"), result.newRecords.size()},
        {QStringLiteral("skippedLines"), result.skippedLines},
    };
}

QJsonObject Service::getAggregated()
{
    qint64 size = 0;
    double mtimeMs = 0;
    if (!statLog(&size, &mtimeMs)) return QJsonObject();

    MemoryState state;
    bool loaded = loadState(size, mtimeMs, &state);
    if (!loaded) {
        refresh();
        if (m_memory.valid && versionEqual(m_memory.fileState, size, mtimeMs)) {
            state = m_memory;
            loaded = true;
        }
    }
    if (!loaded) return QJsonObject();
    return buildAggregatedView(state.intermediate, QDateTime::currentDateTime());
}

} // namespace usage
