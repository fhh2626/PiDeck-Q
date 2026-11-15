#include "XuePrompts.h"

#include "Gzip.h"

#include <QJsonArray>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QUuid>
#include <QVariant>

namespace xueprompts {
namespace {

/**
 * A connection per call.
 *
 * `QSqlDatabase` connections are bound to the thread that created them, and the channel
 * may run on a worker thread. A unique name also means a failed query can never leave a
 * half-open handle that a later call would reuse.
 */
class Connection {
public:
    explicit Connection(const QString &path)
    {
        m_name = QStringLiteral("xueprompts-%1")
                     .arg(QUuid::createUuid().toString(QUuid::WithoutBraces));
        m_database = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), m_name);
        m_database.setDatabaseName(path);
        m_database.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        m_open = m_database.open();
    }
    ~Connection()
    {
        if (m_database.isOpen()) m_database.close();
        m_database = QSqlDatabase();
        QSqlDatabase::removeDatabase(m_name);
    }
    Connection(const Connection &) = delete;
    Connection &operator=(const Connection &) = delete;

    bool isOpen() const { return m_open; }
    QString error() const { return m_database.lastError().text(); }
    QSqlDatabase &database() { return m_database; }

private:
    QString m_name;
    QSqlDatabase m_database;
    bool m_open = false;
};

/** `blobToString`: gunzip when the BLOB is compressed, otherwise read it as UTF-8. */
QString blobToString(const QVariant &value)
{
    if (!value.isValid() || value.isNull()) return {};
    const QByteArray bytes = value.toByteArray();
    if (bytes.isEmpty()) return {};
    QByteArray inflated;
    if (gzip::gunzip(bytes, &inflated)) return QString::fromUtf8(inflated);
    // Legacy rows were written uncompressed; a corrupt gzip stream also lands here,
    // which is exactly the oracle's `catch { return buf.toString("utf8") }`.
    return QString::fromUtf8(bytes);
}

QJsonObject promptItem(const QString &slug, const QString &title, const QString &category,
                       const QString &description)
{
    return QJsonObject{
        {QStringLiteral("slug"), slug},
        {QStringLiteral("title"), title},
        {QStringLiteral("category"), category},
        {QStringLiteral("subcategory"), QString()},
        {QStringLiteral("tags"), QJsonArray{}},
        {QStringLiteral("description"), description},
        {QStringLiteral("path"), slug},
    };
}

} // namespace

Manager::Manager(QString databasePath) : m_databasePath(std::move(databasePath)) {}

Result Manager::list(bool hasOptions, const QString &category, const QString &search, int page,
                     int pageSize)
{
    Result result;
    Connection connection(m_databasePath);
    if (!connection.isOpen()) {
        result.error = QStringLiteral("XuePrompt database is unavailable: %1")
                           .arg(connection.error());
        return result;
    }

    QJsonArray categories;
    {
        QSqlQuery query(connection.database());
        if (!query.exec(QStringLiteral(
                "SELECT slug, name, count FROM xueprompt_categories ORDER BY count DESC"))) {
            result.error = query.lastError().text();
            return result;
        }
        while (query.next()) {
            categories.append(QJsonObject{
                {QStringLiteral("slug"), query.value(0).toString()},
                {QStringLiteral("name"), query.value(1).toString()},
                {QStringLiteral("count"), query.value(2).toLongLong()},
            });
        }
    }

    const QString columns =
        QStringLiteral("SELECT slug, url, title, category, content, description FROM xueprompts");

    if (!hasOptions) {
        // Legacy shape: every row, ordered by category then title, no paging fields.
        QSqlQuery query(connection.database());
        if (!query.exec(columns + QStringLiteral(" ORDER BY category, title"))) {
            result.error = query.lastError().text();
            return result;
        }
        QJsonArray prompts;
        while (query.next()) {
            prompts.append(promptItem(query.value(0).toString(), query.value(2).toString(),
                                      query.value(3).toString(), blobToString(query.value(5))));
        }
        result.ok = true;
        result.value = QJsonObject{
            {QStringLiteral("categories"), categories},
            {QStringLiteral("prompts"), prompts},
            {QStringLiteral("repoPath"), m_databasePath},
        };
        return result;
    }

    QStringList conditions;
    QVariantList parameters;
    if (!category.isEmpty()) {
        // The column stores the raw category name; the renderer sends the slug.
        conditions.append(QStringLiteral(
            "(category = ? OR category = (SELECT name FROM xueprompt_categories WHERE slug = ?))"));
        parameters << category << category;
    }
    if (!search.isEmpty()) {
        conditions.append(QStringLiteral("(title LIKE ? OR description LIKE ?)"));
        const QString like = QStringLiteral("%") + search + QStringLiteral("%");
        parameters << like << like;
    }
    const QString where =
        conditions.isEmpty() ? QString() : QStringLiteral(" WHERE ") + conditions.join(QStringLiteral(" AND "));

    QSqlQuery countQuery(connection.database());
    countQuery.prepare(QStringLiteral("SELECT COUNT(*) FROM xueprompts") + where);
    for (const QVariant &parameter : parameters) countQuery.addBindValue(parameter);
    if (!countQuery.exec() || !countQuery.next()) {
        result.error = countQuery.lastError().text();
        return result;
    }
    const qint64 total = countQuery.value(0).toLongLong();

    const int safePage = page < 1 ? 1 : page;
    const int safePageSize = qBound(1, pageSize, 100);
    const qint64 offset = qint64(safePage - 1) * safePageSize;

    QSqlQuery query(connection.database());
    query.prepare(columns + where + QStringLiteral(" ORDER BY category, title LIMIT ? OFFSET ?"));
    for (const QVariant &parameter : parameters) query.addBindValue(parameter);
    query.addBindValue(safePageSize);
    query.addBindValue(offset);
    if (!query.exec()) {
        result.error = query.lastError().text();
        return result;
    }
    QJsonArray prompts;
    while (query.next()) {
        prompts.append(promptItem(query.value(0).toString(), query.value(2).toString(),
                                  query.value(3).toString(), blobToString(query.value(5))));
    }
    result.ok = true;
    result.value = QJsonObject{
        {QStringLiteral("categories"), categories},
        {QStringLiteral("prompts"), prompts},
        {QStringLiteral("repoPath"), m_databasePath},
        {QStringLiteral("total"), total},
        {QStringLiteral("page"), safePage},
        {QStringLiteral("pageSize"), safePageSize},
    };
    return result;
}

Result Manager::detail(const QString &slug)
{
    Result result;
    Connection connection(m_databasePath);
    if (!connection.isOpen()) {
        result.error = QStringLiteral("XuePrompt database is unavailable: %1")
                           .arg(connection.error());
        return result;
    }
    QSqlQuery query(connection.database());
    query.prepare(QStringLiteral(
        "SELECT title, content, description, url FROM xueprompts WHERE slug = ?"));
    query.addBindValue(slug);
    if (!query.exec()) {
        result.error = query.lastError().text();
        return result;
    }
    if (!query.next()) {
        // A missing row is a legitimate null, not a failure.
        result.ok = true;
        result.value = QJsonObject();
        return result;
    }
    const QString title = query.value(0).toString();
    const QString content = blobToString(query.value(1));
    const QString description = blobToString(query.value(2));
    const QString url = query.value(3).toString();
    const QStringList full = {
        QStringLiteral("---"),
        QStringLiteral("title: %1").arg(title),
        QStringLiteral("description: %1").arg(description),
        QStringLiteral("source: xueprompt"),
        QStringLiteral("url: %1").arg(url),
        QStringLiteral("---"),
        QString(),
        content,
    };
    result.ok = true;
    result.value = QJsonObject{
        {QStringLiteral("title"), title},
        {QStringLiteral("description"), description},
        {QStringLiteral("promptContent"), content},
        {QStringLiteral("fullContent"), full.join(QLatin1Char('\n'))},
    };
    return result;
}

} // namespace xueprompts
