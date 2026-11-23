#include "ChannelContext.h"
#include "FileChannelSupport.h"

#include "BackgroundWork.h"
#include "EntryLink.h"
#include "ExternalFileCapabilities.h"
#include "FileOperations.h"
#include "HostRpcClient.h"
#include "TrashHelper.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QSet>

#include <stdexcept>

using background::Outcome;
using namespace filechannels;

void registerFileMutationChannels(ChannelRegistry &registry, ChannelServices &services)
{
    // ── Writes ────────────────────────────────────────────────────────────────
    registry.addAsync(QStringLiteral("files:write-content"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString path = channels::stringArg(args, 0);
        const QString content = channels::stringArg(args, 1);
        background::runBlocking(
            [&services, path, content]() -> QJsonValue {
                const QString hostPath =
                    channels::authorizePath(services, path, QStringLiteral("write"), pathpolicy::Mode::Write);
                fsops::writeText(hostPath, content);
                return QJsonValue(QJsonValue::Null);
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("files:create"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonValue parentValue = channels::argAt(args, 0);
        const QJsonValue nameValue = channels::argAt(args, 1);
        const QJsonValue typeValue = channels::argAt(args, 2);
        background::runBlocking(
            [&services, parentValue, nameValue, typeValue]() -> QJsonValue {
                assertString(parentValue, QStringLiteral("parentDir"));
                assertString(nameValue, QStringLiteral("name"));
                const QString type = typeValue.toString();
                if (type != QLatin1String("file") && type != QLatin1String("directory")) {
                    throw std::runtime_error("type must be file or directory.");
                }
                const QString parentDir = channels::authorizePath(services, parentValue.toString(),
                                                                  QStringLiteral("create"), pathpolicy::Mode::Read);
                // The final entry is checked too: an existing child symlink must not
                // turn a workspace create into an outside write.
                channels::authorizePath(services, QDir(parentDir).filePath(nameValue.toString()),
                                        QStringLiteral("create"), pathpolicy::Mode::Write);
                return fsops::createEntry(parentDir, nameValue.toString(), type);
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("files:rename"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString path = channels::stringArg(args, 0);
        const QString newName = channels::stringArg(args, 1);
        background::runBlocking(
            [&services, path, newName]() -> QJsonValue {
                const QString hostPath =
                    channels::authorizePath(services, path, QStringLiteral("rename"), pathpolicy::Mode::Link);
                channels::authorizePath(services, QDir(QFileInfo(hostPath).path()).filePath(newName),
                                        QStringLiteral("rename"), pathpolicy::Mode::Write);
                try {
                    return fsops::renameEntry(hostPath, newName);
                } catch (const std::exception &error) {
                    throw textenc::error(localizeFsError(services, error));
                }
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    // ── Copy ──────────────────────────────────────────────────────────────────
    const auto copyInternal = [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonValue sourcesValue = channels::argAt(args, 0);
        const QJsonValue targetValue = channels::argAt(args, 1);
        background::runBlocking(
            [&services, sourcesValue, targetValue]() -> QJsonValue {
                const QStringList sources = assertStringArray(sourcesValue, QStringLiteral("sourcePaths"));
                assertString(targetValue, QStringLiteral("targetDir"));
                return copySources(services, sources, targetValue.toString());
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    };
    // The legacy channel stays as an internal-only alias; it is deliberately no longer
    // an external-path escape hatch.
    registry.addAsync(QStringLiteral("files:copy"), copyInternal);
    registry.addAsync(QStringLiteral("files:copy-internal"), copyInternal);

    registry.addAsync(QStringLiteral("files:copy-external"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonValue capabilityValue = channels::argAt(args, 0);
        const QJsonValue targetValue = channels::argAt(args, 1);
        background::runBlocking(
            [&services, capabilityValue, targetValue]() -> QJsonValue {
                assertString(capabilityValue, QStringLiteral("capabilityId"));
                assertString(targetValue, QStringLiteral("targetDir"));
                if (!services.capabilities) {
                    throw std::runtime_error("External clipboard file capability is unavailable.");
                }
                const QStringList trustedPaths = services.capabilities->consumeCopy(capabilityValue.toString());
                if (trustedPaths.isEmpty()) {
                    throw std::runtime_error("External clipboard file capability is unavailable.");
                }
                const QString hostTargetDir = channels::authorizePath(services, targetValue.toString(),
                                                                      QStringLiteral("copy-target"),
                                                                      pathpolicy::Mode::Read);
                QJsonArray results;
                for (const QString &source : trustedPaths) {
                    const QFileInfo info(source);
                    if (info.isDir()
                        && (fsops::samePath(source, hostTargetDir) || fsops::isPathInside(source, hostTargetDir))) {
                        throw std::runtime_error("Cannot copy a directory into itself");
                    }
                    channels::authorizePath(services, QDir(hostTargetDir).filePath(info.fileName()),
                                            QStringLiteral("copy-target"), pathpolicy::Mode::Write);
                    try {
                        results.append(fsops::copyToFreeName(source, hostTargetDir, info.fileName()));
                    } catch (const std::exception &error) {
                        throw textenc::error(localizeFsError(services, error));
                    }
                }
                return results;
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    // ── Move ──────────────────────────────────────────────────────────────────
    registry.addAsync(QStringLiteral("files:move"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonValue sourcesValue = channels::argAt(args, 0);
        const QJsonValue targetValue = channels::argAt(args, 1);
        background::runBlocking(
            [&services, sourcesValue, targetValue]() -> QJsonValue {
                const QStringList sources = assertStringArray(sourcesValue, QStringLiteral("sourcePaths"));
                assertString(targetValue, QStringLiteral("targetDir"));
                const QString hostTargetDir = channels::authorizePath(services, targetValue.toString(),
                                                                      QStringLiteral("move-target"),
                                                                      pathpolicy::Mode::Read);
                struct Planned {
                    QString hostSource;
                    QString destination;
                };
                QList<Planned> planned;
                QSet<QString> destinations;
                for (const QString &source : sources) {
                    const QString hostSource =
                        channels::authorizePath(services, source, QStringLiteral("move-source"), pathpolicy::Mode::Link);
                    const QString destination = channels::authorizePath(
                        services, QDir(hostTargetDir).filePath(QFileInfo(hostSource).fileName()),
                        QStringLiteral("move-target"), pathpolicy::Mode::Write);
                    // Two sources resolving to the same destination would make the
                    // second move fail halfway; reject the batch up front.
                    QString dedupeKey = QDir::cleanPath(QDir::fromNativeSeparators(destination));
#ifdef Q_OS_WIN
                    dedupeKey = dedupeKey.toLower();
#endif
                    if (destinations.contains(dedupeKey)) {
                        throw textenc::error(QStringLiteral("Destination already exists: %1").arg(destination));
                    }
                    destinations.insert(dedupeKey);
                    planned.append(Planned{hostSource, destination});
                }
                QJsonArray results;
                for (const Planned &move : planned) {
                    if (fsops::samePath(move.hostSource, move.destination)) {
                        results.append(move.destination);
                        continue;
                    }
                    // A link to a directory is not a directory (lstat semantics): moving a
                    // junction must move the link, never recurse into its referent.
                    const bool sourceIsRealDirectory = fsops::isRealDirectory(move.hostSource);
                    if (sourceIsRealDirectory && fsops::isPathInside(move.hostSource, move.destination)) {
                        throw std::runtime_error("Cannot move a directory into itself");
                    }
                    // A dangling link already occupies the destination name.
                    if (fsops::entryExists(move.destination)) {
                        throw textenc::error(QStringLiteral("Destination already exists: %1").arg(move.destination));
                    }
                    try {
                        // Copy first, then remove the source: a failed copy must never
                        // lose the original.
                        fsops::copyWithoutOverwrite(move.hostSource, move.destination);
                    } catch (const std::exception &error) {
                        const QString message = QString::fromUtf8(error.what());
                        if (message == QLatin1String(fsops::kUnsupportedCopyTypeCode)) {
                            throw textenc::error(localized(services, QStringLiteral("mainFile.unsupportedMoveType")));
                        }
                        throw;
                    }
                    if (sourceIsRealDirectory) {
                        // Link-aware tree removal: a real directory is emptied child by child,
                        // but a junction inside it is unlinked as a link. `QDir::removeRecursively()`
                        // would classify that junction as a directory and delete the content
                        // behind it (irreversible data loss outside the project).
                        try {
                            fsops::removeEntryTree(move.hostSource);
                        } catch (const std::exception &error) {
                            // Keep the failing path/entry from the filesystem layer.
                            throw textenc::error(QString::fromUtf8(error.what()));
                        }
                    } else if (!fsops::removeEntry(move.hostSource)) {
                        // Files and links are removed as single entries: deleting a
                        // junction removes the link, not the directory it points at.
                        throw textenc::error(QStringLiteral("Unable to remove %1").arg(move.hostSource));
                    }
                    results.append(move.destination);
                }
                return results;
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    // ── Delete (recycle bin) ──────────────────────────────────────────────────
    registry.addAsync(QStringLiteral("files:delete"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString path = channels::stringArg(args, 0);
        // Deletion is a link operation: the parent chain is resolved but the leaf is
        // not followed, so removing a link never touches its referent.
        const QString hostPath = [&]() -> QString {
            try {
                return channels::authorizePath(services, path, QStringLiteral("delete"), pathpolicy::Mode::Link);
            } catch (const ChannelError &error) {
                throw textenc::error(error.message());
            }
        }();
        if (!services.host) return responder.reject(QStringLiteral("Native host bridge is unavailable"));
        // User deletions always go to the recycle bin; a hard unlink is never offered.
        auto request = services.host->request(QStringLiteral("shell.trashItem"), QJsonObject{
            {QStringLiteral("path"), hostPath},
        });
        request->then([responder](const QJsonValue &) mutable { responder.resolve(QJsonValue(QJsonValue::Null)); });
        request->fail([responder](const QString &error) mutable { responder.reject(error); });
    });

    // ── Shell integration ─────────────────────────────────────────────────────
    registry.addAsync(QStringLiteral("files:open"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString path = channels::stringArg(args, 0);
        background::runBlocking(
            [&services, path]() -> QJsonValue {
                return channels::authorizePath(services, path, QStringLiteral("open"), pathpolicy::Mode::Read);
            },
            [&services, responder](const Outcome &outcome) mutable {
                if (!outcome.ok) return responder.reject(outcome.error);
                if (!services.host) return responder.reject(QStringLiteral("Native host bridge is unavailable"));
                auto request = services.host->request(QStringLiteral("shell.openPath"), QJsonObject{
                    {QStringLiteral("path"), outcome.value.toString()},
                });
                request->then([responder](const QJsonValue &value) mutable {
                    const QJsonObject result = value.toObject();
                    if (!result.value(QStringLiteral("ok")).toBool(true)) {
                        return responder.reject(result.value(QStringLiteral("error")).toString(
                            QStringLiteral("Unable to open the path")));
                    }
                    responder.resolve(QJsonValue(QJsonValue::Null));
                });
                request->fail([responder](const QString &error) mutable { responder.reject(error); });
            });
    });

    registry.addAsync(QStringLiteral("files:show-in-folder"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString path = channels::stringArg(args, 0);
        background::runBlocking(
            [&services, path]() -> QJsonValue {
                return channels::authorizePath(services, path, QStringLiteral("show-in-folder"),
                                               pathpolicy::Mode::Read);
            },
            [&services, responder](const Outcome &outcome) mutable {
                if (!outcome.ok) return responder.reject(outcome.error);
                if (!services.host) return responder.reject(QStringLiteral("Native host bridge is unavailable"));
                auto request = services.host->request(QStringLiteral("shell.showItemInFolder"), QJsonObject{
                    {QStringLiteral("path"), outcome.value.toString()},
                });
                request->then([responder](const QJsonValue &value) mutable {
                    const QJsonObject result = value.toObject();
                    if (!result.value(QStringLiteral("ok")).toBool()) {
                        return responder.reject(result.value(QStringLiteral("error")).toString(
                            QStringLiteral("Unable to reveal the path")));
                    }
                    responder.resolve(QJsonValue(QJsonValue::Null));
                });
                request->fail([responder](const QString &error) mutable { responder.reject(error); });
            });
    });
}
