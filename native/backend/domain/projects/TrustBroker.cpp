#include "TrustBroker.h"

#include "EventHub.h"
#include "JsonFile.h"

#include "../../process/TextEncoding.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonValue>
#include <QTimer>
#include <QUuid>

namespace projects {
namespace {

constexpr int kTrustPromptTimeoutMs = 60'000;

/** `normalizeTrustPath`: Linux paths use POSIX normalization, Windows uses QDir. */
QString normalizeTrustPath(const QString &path)
{
    if (!path.startsWith(QLatin1Char('/'))) return QDir::cleanPath(path);
    QString normalized = QDir::cleanPath(path);
    while (normalized.size() > 1 && normalized.endsWith(QLatin1Char('/'))) normalized.chop(1);
    return normalized;
}

/** Windows comparisons ignore case; Linux paths keep theirs. */
QString normalizeTrustKey(const QString &path)
{
    QString normalized = normalizeTrustPath(path);
    while (normalized.endsWith(QLatin1Char('/')) || normalized.endsWith(QLatin1Char('\\'))) {
        normalized.chop(1);
    }
#ifdef Q_OS_WIN
    if (!normalized.startsWith(QLatin1Char('/'))) return normalized.toLower();
#endif
    return normalized;
}

/** Parent of a normalized key, using the POSIX rules for Linux paths. */
QString parentKey(const QString &key)
{
    if (key.startsWith(QLatin1Char('/'))) {
        const int slash = key.lastIndexOf(QLatin1Char('/'));
        if (slash <= 0) return QStringLiteral("/");
        return key.left(slash);
    }
    const QFileInfo info(key);
    return info.absolutePath();
}

} // namespace

TrustBroker::TrustBroker(QString agentDir, EventHub *events)
    : m_agentDir(std::move(agentDir))
    , m_events(events)
{
}

QJsonObject TrustBroker::readConfig() const
{
    QJsonValue value;
    if (jsonfile::readJson(QDir(m_agentDir).filePath(QStringLiteral("trust.json")), &value, nullptr)
        != jsonfile::ReadState::Ok) {
        return {};
    }
    return value.toObject();
}

QJsonValue TrustBroker::decision(const QString &cwd, bool *readError) const
{
    if (readError) *readError = false;
    const QString path = QDir(m_agentDir).filePath(QStringLiteral("trust.json"));
    QJsonValue value;
    const jsonfile::ReadState state = jsonfile::readJson(path, &value, nullptr);
    if (state == jsonfile::ReadState::Missing) return QJsonValue(QJsonValue::Null);
    if (state != jsonfile::ReadState::Ok) {
        if (readError) *readError = true;
        return QJsonValue(QJsonValue::Null);
    }
    QHash<QString, bool> normalized;
    const QJsonObject raw = value.toObject();
    for (auto iterator = raw.constBegin(); iterator != raw.constEnd(); ++iterator) {
        normalized.insert(normalizeTrustKey(iterator.key()), iterator.value().toBool(false));
    }
    QString current = normalizeTrustKey(cwd);
    for (;;) {
        const auto found = normalized.constFind(current);
        if (found != normalized.constEnd()) return QJsonValue(*found);
        const QString parent = parentKey(current);
        if (parent == current) return QJsonValue(QJsonValue::Null);
        current = parent;
    }
}

void TrustBroker::setDecision(const QString &cwd, bool trusted)
{
    QJsonObject trust = readConfig();
    trust.insert(normalizeTrustPath(cwd), trusted);
    QString error;
    if (!jsonfile::writeJsonAtomic(QDir(m_agentDir).filePath(QStringLiteral("trust.json")), trust,
                                   &error)) {
        throw textenc::error(error);
    }
}

void TrustBroker::ensureTrusted(const QString &directoryPath)
{
    const QString normalizedPath = normalizeTrustPath(directoryPath);
    const QJsonObject trust = readConfig();
    const QString wanted = normalizeTrustKey(normalizedPath);
    for (auto iterator = trust.constBegin(); iterator != trust.constEnd(); ++iterator) {
        // An existing spelling (different case or separators) or an explicit false is
        // respected; only a genuinely unknown directory is recorded.
        if (normalizeTrustKey(iterator.key()) == wanted) return;
    }
    QJsonObject next = trust;
    next.insert(normalizedPath, true);
    QString error;
    jsonfile::writeJsonAtomic(QDir(m_agentDir).filePath(QStringLiteral("trust.json")), next, &error);
}

void TrustBroker::request(const QString &cwd, const QString &projectName,
                          std::function<void(const TrustChoice &)> done)
{
    if (!m_events) {
        // No renderer channel means no window to ask: fail closed rather than grant.
        return done(QStringLiteral("deny"));
    }
    const QString requestId = QUuid::createUuid().toString(QUuid::WithoutBraces);
    // The timeout timer is owned by the broker instead of `QTimer::singleShot`: a pending
    // anonymous timer cannot be cancelled, keeps a `this` capture alive past
    // ~TrustBroker, and makes process teardown hang once the event loop has stopped.
    auto *timeout = new QTimer();
    timeout->setSingleShot(true);
    QObject::connect(timeout, &QTimer::timeout, timeout, [this, requestId] {
        const auto found = m_pending.find(requestId);
        if (found == m_pending.end()) return;
        auto callback = found.value().done;
        QTimer *expired = found.value().timeout;
        m_pending.erase(found);
        if (expired) expired->deleteLater();
        callback(QStringLiteral("deny"));
    });
    timeout->start(kTrustPromptTimeoutMs);
    m_pending.insert(requestId, Pending{std::move(done), timeout});
    m_events->broadcast(QStringLiteral("projects:trust-request"),
                        QJsonArray{QJsonObject{
                            {QStringLiteral("requestId"), requestId},
                            {QStringLiteral("cwd"), cwd},
                            {QStringLiteral("projectName"), projectName},
                        }});
}

void TrustBroker::respond(const QString &requestId, const TrustChoice &choice)
{
    const auto found = m_pending.find(requestId);
    if (found == m_pending.end()) return;
    auto callback = found.value().done;
    QTimer *timeout = found.value().timeout;
    m_pending.erase(found);
    // Deleted synchronously: the answer settles the pending entry right here, and a queued
    // delete could fire after the event loop is gone.
    delete timeout;
    callback(choice);
}

void TrustBroker::cancelAll()
{
    const auto pending = m_pending;
    m_pending.clear();
    for (const Pending &entry : pending) {
        if (entry.timeout) delete entry.timeout;
        if (entry.done) entry.done(QStringLiteral("deny"));
    }
}

TrustBroker::~TrustBroker()
{
    cancelAll();
}

} // namespace projects
