#include "ChannelContext.h"
#include "FileChannelSupport.h"

#include "BackgroundWork.h"
#include "ExternalFileCapabilities.h"
#include "FileOperations.h"
#include "HostRpcClient.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QSet>

#include <stdexcept>

using background::Outcome;
using namespace filechannels;

void registerFileMutationChannels(ChannelRegistry &registry, ChannelServices &services);

void registerFileChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registerFileMutationChannels(registry, services);

    // ── Native dialogs ────────────────────────────────────────────────────────
    registry.addAsync(QStringLiteral("dialog:pick-files"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        if (!services.host) return responder.reject(QStringLiteral("Native host bridge is unavailable"));
        const QJsonObject options = channels::objectArg(args, 0);
        QJsonObject params;
        const QString title = options.value(QStringLiteral("title")).toString();
        if (!title.isEmpty()) params.insert(QStringLiteral("title"), title);
        // A native picker cannot mix files and directories, so includeDirectories is
        // an explicit directory-selection mode.
        params.insert(QStringLiteral("properties"),
                      options.value(QStringLiteral("includeDirectories")).toBool()
                          ? QJsonArray{QStringLiteral("openDirectory")}
                          : QJsonArray{QStringLiteral("openFile"), QStringLiteral("multiSelections")});
        params.insert(QStringLiteral("parent"), QStringLiteral("none"));
        auto request = services.host->request(QStringLiteral("dialog.open"), params);
        request->then([responder](const QJsonValue &value) mutable {
            const QJsonObject result = value.toObject();
            if (result.value(QStringLiteral("canceled")).toBool()) return responder.resolve(QJsonArray{});
            responder.resolve(result.value(QStringLiteral("filePaths")).toArray());
        });
        request->fail([responder](const QString &error) mutable { responder.reject(error); });
    });

    registry.addAsync(QStringLiteral("dialog:pick-images"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        if (!services.host) return responder.reject(QStringLiteral("Native host bridge is unavailable"));
        QJsonObject params;
        const QJsonObject options = channels::objectArg(args, 0);
        const QString title = options.value(QStringLiteral("title")).toString().trimmed();
        if (!title.isEmpty()) params.insert(QStringLiteral("title"), title);
        params.insert(QStringLiteral("properties"),
                      QJsonArray{QStringLiteral("openFile"), QStringLiteral("multiSelections")});
        params.insert(QStringLiteral("filters"), QJsonArray{QJsonObject{
            {QStringLiteral("name"), QStringLiteral("Images")},
            {QStringLiteral("extensions"),
             QJsonArray{QStringLiteral("png"), QStringLiteral("jpg"), QStringLiteral("jpeg"), QStringLiteral("gif"),
                        QStringLiteral("webp")}},
        }});
        params.insert(QStringLiteral("parent"), QStringLiteral("none"));
        auto request = services.host->request(QStringLiteral("dialog.open"), params);
        request->then([&services, responder](const QJsonValue &value) mutable {
            const QJsonObject result = value.toObject();
            if (result.value(QStringLiteral("canceled")).toBool()) {
                return responder.resolve(QJsonObject{{QStringLiteral("kind"), QStringLiteral("cancelled")}});
            }
            QStringList unique;
            for (const QJsonValue &item : result.value(QStringLiteral("filePaths")).toArray()) {
                const QString path = item.toString();
                if (!path.isEmpty() && !unique.contains(path)) unique.append(path);
            }
            if (unique.isEmpty()) {
                return responder.resolve(QJsonObject{{QStringLiteral("kind"), QStringLiteral("cancelled")}});
            }
            if (unique.size() > 16) {
                return responder.resolve(QJsonObject{{QStringLiteral("kind"), QStringLiteral("error")},
                                                     {QStringLiteral("code"), QStringLiteral("TOO_MANY_FILES")}});
            }
            if (!services.capabilities) {
                return responder.resolve(QJsonObject{{QStringLiteral("kind"), QStringLiteral("error")},
                                                     {QStringLiteral("code"), QStringLiteral("PICKER_FAILED")}});
            }
            const QString capabilityId = services.capabilities->issuePicker(unique);
            if (capabilityId.isEmpty()) {
                return responder.resolve(QJsonObject{{QStringLiteral("kind"), QStringLiteral("error")},
                                                     {QStringLiteral("code"), QStringLiteral("PICKER_FAILED")}});
            }
            QJsonArray paths;
            for (const QString &path : unique) paths.append(path);
            responder.resolve(QJsonObject{{QStringLiteral("kind"), QStringLiteral("selected")},
                                          {QStringLiteral("capabilityId"), capabilityId},
                                          {QStringLiteral("paths"), paths}});
        });
        request->fail([responder](const QString &) mutable {
            responder.resolve(QJsonObject{{QStringLiteral("kind"), QStringLiteral("error")},
                                          {QStringLiteral("code"), QStringLiteral("PICKER_FAILED")}});
        });
    });

    // ── Reads ─────────────────────────────────────────────────────────────────
    registry.addAsync(QStringLiteral("files:list"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        background::runBlocking(
            [&services, projectId]() -> QJsonValue {
                const QString projectPath = channels::resolveProjectPath(services, projectId);
                const QString hostPath =
                    channels::authorizePath(services, projectPath, QStringLiteral("list"), pathpolicy::Mode::Read);
                return fsops::listTree(hostPath);
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("files:read-content"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString path = channels::stringArg(args, 0);
        const qint64 maxBytes = optionalMaxBytes(args, 1);
        const auto scope = channels::pathAuthorizationScope(services);
        background::runInteractiveRead(
            [scope, path, maxBytes]() -> QJsonValue {
                const QString hostPath =
                    channels::authorizePath(scope, path, QStringLiteral("read"), pathpolicy::Mode::Read);
                return fsops::readText(hostPath, maxBytes).content;
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("files:read-base64"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString path = channels::stringArg(args, 0);
        const qint64 maxBytes = optionalMaxBytes(args, 1);
        const auto scope = channels::pathAuthorizationScope(services);
        background::runInteractiveRead(
            [scope, path, maxBytes]() -> QJsonValue {
                const QString hostPath =
                    channels::authorizePath(scope, path, QStringLiteral("read-base64"), pathpolicy::Mode::Read);
                return fsops::readBase64(hostPath, maxBytes).content;
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("files:read-base64-external"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonValue capabilityValue = channels::argAt(args, 0);
        const QJsonValue pathValue = channels::argAt(args, 1);
        const QJsonValue maxValue = channels::argAt(args, 2);
        background::runBlocking(
            [&services, capabilityValue, pathValue, maxValue]() -> QJsonValue {
                assertString(capabilityValue, QStringLiteral("capabilityId"));
                assertString(pathValue, QStringLiteral("path"));
                if (!maxValue.isDouble() || !(maxValue.toDouble() > 0)
                    || maxValue.toDouble() > double(kMaxExternalReadBytes)) {
                    throw textenc::error(
                        QStringLiteral("External clipboard reads require maxBytes between 1 and %1.")
                            .arg(kMaxExternalReadBytes));
                }
                if (!services.capabilities) {
                    throw std::runtime_error("External clipboard file capability is unavailable.");
                }
                // The renderer value is only a selector; the trusted path comes from
                // the capability the native host issued.
                const QString trustedPath = services.capabilities->consumeRead(capabilityValue.toString(),
                                                                              pathValue.toString());
                if (trustedPath.isEmpty()) {
                    throw std::runtime_error("External clipboard file capability is unavailable.");
                }
                return fsops::readBase64(trustedPath, qint64(maxValue.toDouble())).content;
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });
}
