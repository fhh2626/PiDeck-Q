#include "CacheHitStats.h"

#include <QDateTime>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QJsonValue>
#include <QVector>

namespace cachehit {
namespace {

/** Text characters for the context-share estimate; `content` arrays and bare `text`. */
int messageTextChars(const QJsonObject &message)
{
    int chars = 0;
    const QJsonValue text = message.value(QStringLiteral("text"));
    if (text.isString()) chars += text.toString().size();
    const QJsonArray content = message.value(QStringLiteral("content")).toArray();
    for (const QJsonValue &part : content) {
        if (!part.isObject()) continue;
        const QJsonObject object = part.toObject();
        if (object.value(QStringLiteral("type")).toString() != QLatin1String("text")) continue;
        chars += object.value(QStringLiteral("text")).toString().size();
    }
    return chars;
}

} // namespace

bool hitRateFromUsage(const QJsonObject &usage, double *out)
{
    const double input = usage.value(QStringLiteral("input")).toDouble(0);
    const double cacheRead = usage.value(QStringLiteral("cacheRead")).toDouble(0);
    const double cacheWrite = usage.value(QStringLiteral("cacheWrite")).toDouble(0);
    const double promptTokens = input + cacheRead + cacheWrite;
    if (promptTokens <= 0) return false;
    if (out) *out = (cacheRead / promptTokens) * 100.0;
    return true;
}

Stats compute(const QByteArray &raw)
{
    Stats stats;
    QVector<double> rates;
    // Reverse pass, exactly like the oracle: the first hit found is the *last* assistant
    // message, so "latest" needs no forward bookkeeping.
    const QList<QByteArray> lines = raw.split('\n');
    for (auto iterator = lines.crbegin(); iterator != lines.crend(); ++iterator) {
        const QByteArray line = iterator->trimmed();
        if (line.isEmpty()) continue;
        QJsonParseError parseError;
        const QJsonDocument document = QJsonDocument::fromJson(line, &parseError);
        if (parseError.error != QJsonParseError::NoError || !document.isObject()) continue;
        const QJsonObject entry = document.object();
        const QJsonValue messageValue = entry.value(QStringLiteral("message"));
        if (!messageValue.isObject()) continue;
        const QJsonObject message = messageValue.toObject();
        stats.messageChars += messageTextChars(message);
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("assistant")) continue;
        const QJsonValue usage = message.value(QStringLiteral("usage"));
        if (!usage.isObject()) continue;
        double rate = 0;
        if (!hitRateFromUsage(usage.toObject(), &rate)) continue;
        if (!stats.hasLatest) {
            stats.hasLatest = true;
            stats.latest = rate;
        }
        rates.append(rate);
    }
    if (rates.isEmpty()) return stats;
    double sum = 0;
    for (double rate : rates) sum += rate;
    stats.hasAverage = true;
    stats.average = sum / double(rates.size());
    stats.sampleCount = int(rates.size());
    return stats;
}

Stats Reader::read(const QString &sessionPath)
{
    if (sessionPath.isEmpty()) return Stats{};
    const QFileInfo info(sessionPath);
    if (!info.exists() || !info.isFile()) {
        m_cache.remove(sessionPath);
        return Stats{};
    }
    const qint64 size = info.size();
    const double mtimeMs = double(info.lastModified().toMSecsSinceEpoch());
    const auto cached = m_cache.constFind(sessionPath);
    if (cached != m_cache.constEnd() && cached->size == size && cached->mtimeMs == mtimeMs) {
        return cached->stats;
    }
    QFile file(sessionPath);
    if (!file.open(QIODevice::ReadOnly)) {
        // A file that cannot be read is not cached (the oracle behaves the same), so a
        // later read after the lock is released sees the real content.
        m_cache.remove(sessionPath);
        return Stats{};
    }
    const Stats stats = compute(file.readAll());
    // Defensive bound: sessions are far fewer than this, but a pathological catalog must
    // not grow the process forever. Clearing (not evicting one) matches the oracle.
    if (m_cache.size() >= 100) m_cache.clear();
    m_cache.insert(sessionPath, Entry{size, mtimeMs, stats});
    return stats;
}

} // namespace cachehit
