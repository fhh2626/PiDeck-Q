#pragma once

#include <QJsonObject>
#include <QString>

#include <functional>

/**
 * The bundled Chinese prompt library (`yao-prompts:*`).
 *
 * Port of src/main/prompts/XuePromptManager.ts. `resources/xueprompts.db` is a SQLite
 * file (3999 rows, 16 categories) whose `content`/`description` columns are
 * gzip-compressed BLOBs; the schema is fixed and read-only, so the manager only issues
 * parameterised SELECTs and never writes.
 *
 * Two invariants matter for parity:
 *  - the category filter matches the *raw* category name, which is resolved from the
 *    slug through a subquery (the slug is kebab-cased, the column is not);
 *  - `pageSize` is clamped to 1..100 and `page` to >= 1, and the full list (no options)
 *    keeps the legacy unpaged shape.
 */
namespace xueprompts {

/** Result of one query; `error` is the localized failure copy. */
struct Result {
    bool ok = false;
    QJsonObject value;
    QString error;
};

class Manager {
public:
    explicit Manager(QString databasePath);

    const QString &databasePath() const { return m_databasePath; }

    /** `list(opts)`: `hasOptions == false` reproduces the legacy full-list shape. */
    Result list(bool hasOptions, const QString &category, const QString &search, int page,
                int pageSize);

    /** One prompt detail; `ok` with a null value means "not found". */
    Result detail(const QString &slug);

    /** `importToPi`: write the prompt into the global template directory. */
    struct ImportResult {
        bool ok = false;
        QJsonObject summary;
        QString error;
    };

private:
    QString m_databasePath;
};

} // namespace xueprompts
