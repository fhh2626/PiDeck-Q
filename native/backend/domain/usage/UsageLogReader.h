#pragma once

/**
 * `usage.jsonl` 的行解析与游标增量读取。
 *
 * 游标 = { size, mtimeMs, ino, count }，以 append-only 为前提：
 *  - size 与 mtime 都没变 → 空增量（零 IO）
 *  - size 变大 → 只读新增字节段
 *  - size 变小 / ino 变化 / 同尺寸重写 → 全量重扫（截断与重写都要安全）
 *
 * 行切分严格按 LF：JSON 字符串里允许出现 U+2028/U+2029，按“行分隔符”切会切坏记录。
 * 行尾 `\r` 剥离以兼容 CRLF。坏行跳过并计数，不中断整次读取。
 */

#include <QString>
#include <QVector>

#include "UsageTypes.h"

namespace usage {

/** 单次读取字节上限：防御日志失控导致的全量读 OOM（超限截读并标记 truncated）。 */
constexpr qint64 kDefaultMaxLogBytes = 256LL * 1024 * 1024;

/** 游标：上次读取结束时的文件状态。 */
struct FileState {
    qint64 size = 0;
    double mtimeMs = 0;
    /** 跨平台 inode（Windows 亦可取），检测同名文件被替换。 */
    quint64 ino = 0;
    bool hasIno = false;
    /** 已累计解析的唯一记录数。 */
    qint64 count = 0;
};

struct ReadResult {
    QVector<Record> newRecords;
    bool fullRescan = false;
    bool truncated = false;
    /** 文件不存在时为 false（调用方视为「未安装」）。 */
    bool hasFileState = false;
    FileState fileState;
    int skippedLines = 0;
};

/** 解析一行；非法行返回 false（调用方计数，不中断）。 */
bool parseLine(const QString &line, Record *record);

/** 增量读取；文件不存在返回 hasFileState=false。 */
ReadResult readIncremental(const QString &logPath, const FileState *previous,
                           qint64 maxBytes = kDefaultMaxLogBytes);

} // namespace usage
