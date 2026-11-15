#include "FileChannelSupport.h"

#include "../process/TextEncoding.h"

#include "EntryLink.h"
#include "FileOperations.h"
#include "MainCopy.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonObject>

#include <stdexcept>

namespace filechannels {

QString language(const ChannelServices &services)
{
    return channels::settingValue(services, QStringLiteral("language")).toString();
}

QString localized(const ChannelServices &services, const QString &key)
{
    return maincopy::text(language(services), key);
}

void settle(ChannelResponder responder, const background::Outcome &outcome)
{
    if (outcome.ok) responder.resolve(outcome.value);
    else responder.reject(outcome.error);
}

QString localizeFsError(const ChannelServices &services, const std::exception &error)
{
    const QString message = QString::fromUtf8(error.what());
    if (message.startsWith(QLatin1String(fsops::kRenameTargetExistsCode))) {
        return localized(services, QStringLiteral("mainFile.renameTargetExists"));
    }
    if (message == QLatin1String(fsops::kUnsupportedCopyTypeCode)) {
        return localized(services, QStringLiteral("mainFile.unsupportedCopyType"));
    }
    return message;
}

void assertString(const QJsonValue &value, const QString &field)
{
    if (!value.isString() || value.toString().isEmpty()) {
        throw textenc::error(QStringLiteral("%1 must be a non-empty string.").arg(field));
    }
}

QStringList assertStringArray(const QJsonValue &value, const QString &field)
{
    const QJsonArray array = value.toArray();
    if (!value.isArray() || array.isEmpty()) {
        throw textenc::error(QStringLiteral("%1 must be a non-empty string array.").arg(field));
    }
    QStringList result;
    for (const QJsonValue &item : array) {
        if (!item.isString() || item.toString().isEmpty()) {
            throw textenc::error(QStringLiteral("%1 must be a non-empty string array.").arg(field));
        }
        result.append(item.toString());
    }
    return result;
}

qint64 optionalMaxBytes(const QJsonArray &args, int index)
{
    const QJsonValue value = channels::argAt(args, index);
    if (!value.isDouble()) return 0;
    const double number = value.toDouble();
    if (!(number > 0)) return 0;
    return qint64(number);
}

QJsonValue copySources(const ChannelServices &services, const QStringList &sourcePaths, const QString &targetDir)
{
    const QString hostTargetDir = channels::authorizePath(services, targetDir, QStringLiteral("copy-target"),
                                                          pathpolicy::Mode::Read);
    QJsonArray results;
    for (const QString &source : sourcePaths) {
        const QString hostSource =
            channels::authorizePath(services, source, QStringLiteral("copy-source"), pathpolicy::Mode::Read);
        const QFileInfo sourceInfo(hostSource);
        // Copying a directory into itself or into a child would recurse forever. The guard
        // must use lstat semantics (`fsops::isRealDirectory`): the oracle tests
        // `lstat().isDirectory()`, so a link to a directory is copied as a link and never
        // recursed into, no matter where its referent lives.
        if (fsops::isRealDirectory(hostSource)
            && (fsops::samePath(hostSource, hostTargetDir) || fsops::isPathInside(hostSource, hostTargetDir))) {
            throw std::runtime_error("Cannot copy a directory into itself");
        }
        channels::authorizePath(services, QDir(hostTargetDir).filePath(sourceInfo.fileName()),
                                QStringLiteral("copy-target"), pathpolicy::Mode::Write);
        try {
            results.append(fsops::copyToFreeName(hostSource, hostTargetDir, sourceInfo.fileName()));
        } catch (const std::exception &error) {
            throw textenc::error(localizeFsError(services, error));
        }
    }
    return results;
}

} // namespace filechannels
