#pragma once

#include "SessionFileMutations.h"

#include <QByteArray>
#include <QHash>
#include <QJsonObject>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QVector>

/**
 * pi session JSONL document layer: parsing, line-preserving serialization and the
 * parent/leaf graph that pi's SessionManager rebuilds on load.
 *
 * Kept separate from the mutation transactions so the file format rules (one `session`
 * header, `parentId` chain, leaf = last entry with an id) live in one place and stay
 * unit-testable. Nothing here decides *what* to change; `SessionFileMutations` does.
 */
namespace sessionfiledoc {

using sessionmutations::Result;
using sessionmutations::Target;

struct Line {
    QString content;
    QString eol;
    QJsonObject entry;
    bool hasEntry = false;
};

struct Document {
    QVector<Line> lines;
    QHash<QString, int> entryLineById;
};

struct Located {
    int lineIndex = -1;
    QString entryId;
};

QString entryIdOf(const QJsonObject &entry);
QJsonValue parentIdOf(const QJsonObject &entry);
QJsonObject messageOf(const QJsonObject &entry);
QString textOf(const QJsonValue &content);
void setMessageText(QJsonObject &message, const QString &text);

bool fail(Result *result, const QString &code, const QString &error);
bool parseDocument(const QByteArray &bytes, Document *document, Result *result);
QByteArray serializeDocument(const Document &document);
void replaceLine(Document *document, int lineIndex, const QJsonObject &entry);

/** Entry ids on the active branch, walking `parentId` back from the leaf. */
QSet<QString> activeBranchIds(const Document &document, const QString &activeLeafId,
                              Result *result);
QString legacyEntryId(const Target &target);
bool locateEntry(const Document &document, const Target &target, Located *out, Result *result);
QString inputRole(const QJsonObject &entry);
QStringList turnSegmentMessageIds(const Document &document, const QString &targetEntryId,
                                  const QString &activeLeafId, Result *result);
QSet<QString> descendantEntryIds(const Document &document, const QString &rootEntryId);
QStringList rewriteCompactionFirstKept(Document *document, const QSet<QString> &removeSet);

QJsonObject tombstone(const QString &entryId, qint64 now, const QJsonValue &parentId,
                      const QString &reason = QString());

bool writeBackup(const QString &filePath, const QByteArray &original, Result *result);
bool writeSessionFile(const QString &filePath, const QByteArray &bytes, Result *result);

} // namespace sessionfiledoc
