#include "JsonFile.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QSaveFile>
#include <QStringList>
#include <QThread>
#include <QUuid>

namespace jsonfile {
namespace {

/** QJsonDocument only emits four-space indentation; rewrite the structural indent only. */
QByteArray toTwoSpaceIndent(const QByteArray &fourSpace)
{
    QByteArray out;
    out.reserve(fourSpace.size());
    const QList<QByteArray> lines = fourSpace.split('\n');
    for (int index = 0; index < lines.size(); ++index) {
        const QByteArray &line = lines.at(index);
        int spaces = 0;
        while (spaces < line.size() && line.at(spaces) == ' ') ++spaces;
        out.append(QByteArray(spaces / 2, ' '));
        out.append(line.mid(spaces));
        if (index + 1 < lines.size()) out.append('\n');
    }
    return out;
}

} // namespace

QByteArray prettyJson(const QJsonValue &value)
{
    const QJsonDocument document =
        value.isArray() ? QJsonDocument(value.toArray())
                        : QJsonDocument(value.isObject() ? value.toObject() : QJsonObject{});
    QByteArray encoded = toTwoSpaceIndent(document.toJson(QJsonDocument::Indented));
    // JSON.stringify never ends with a newline; QJsonDocument always does.
    while (encoded.endsWith('\n')) encoded.chop(1);
    return encoded;
}

bool writeBytesAtomic(const QString &path, const QByteArray &bytes, QString *error)
{
    const QFileInfo info(path);
    if (!QDir().mkpath(info.absolutePath())) {
        if (error) *error = QStringLiteral("Unable to create %1").arg(info.absolutePath());
        return false;
    }
    // Rename retry window: `renameWithRetry` in the oracle (0/20/75/200 ms, ~300 ms).
    // Windows returns a sharing violation while AV/indexers/cloud sync hold the target;
    // without the retry one transient lock lost the user's settings change. QSaveFile is
    // kept because it preserves the target's permissions (auth.json may be 0600) and
    // removes its sibling temp file when commit fails, unlike a hand-rolled rename.
    static const int kRetryDelaysMs[] = {0, 20, 75, 200};
    QString lastError;
    for (int attempt = 0; attempt < 4; ++attempt) {
        if (kRetryDelaysMs[attempt] > 0) QThread::msleep(static_cast<unsigned long>(kRetryDelaysMs[attempt]));
        QSaveFile file(path);
        if (!file.open(QIODevice::WriteOnly)) {
            lastError = QStringLiteral("Unable to write %1").arg(path);
            continue;
        }
        if (file.write(bytes) != bytes.size()) {
            lastError = QStringLiteral("Unable to write %1").arg(path);
            file.cancelWriting();
            continue;
        }
        if (file.commit()) return true;
        lastError = QStringLiteral("Unable to commit %1").arg(path);
    }
    if (error) *error = lastError;
    return false;
}

bool writeJsonAtomic(const QString &path, const QJsonValue &value, QString *error)
{
    return writeBytesAtomic(path, prettyJson(value), error);
}

bool readText(const QString &path, QString *out)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return false;
    if (out) *out = QString::fromUtf8(file.readAll());
    return true;
}

ReadState readJson(const QString &path, QJsonValue *out, QString *error)
{
    QFile file(path);
    if (!file.exists()) return ReadState::Missing;
    if (!file.open(QIODevice::ReadOnly)) {
        if (error) *error = QStringLiteral("Unable to read %1").arg(path);
        return ReadState::Unreadable;
    }
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError) {
        if (error) *error = parseError.errorString();
        return ReadState::Invalid;
    }
    if (out) {
        *out = document.isArray() ? QJsonValue(document.array())
                                  : QJsonValue(document.object());
    }
    return ReadState::Ok;
}

QString preserveCorrupt(const QString &path, QString *error)
{
    QString backupPath = path + QStringLiteral(".corrupt");
    for (;;) {
        if (QFileInfo::exists(backupPath)) {
            backupPath = path + QStringLiteral(".corrupt.")
                + QUuid::createUuid().toString(QUuid::WithoutBraces);
            continue;
        }
        if (!QFile::copy(path, backupPath)) {
            // Either the name was taken between the check and the copy, or the copy
            // failed for a real reason. A second attempt with a unique name resolves the
            // race; a genuine failure is reported so the caller refuses to rebuild.
            const QString unique = path + QStringLiteral(".corrupt.")
                + QUuid::createUuid().toString(QUuid::WithoutBraces);
            if (QFile::copy(path, unique)) return unique;
            if (error) *error = QStringLiteral("Unable to preserve %1").arg(path);
            return {};
        }
        return backupPath;
    }
}

} // namespace jsonfile
