#include "ChannelContext.h"

#include "HostRpcClient.h"
#include "PiLaunch.h"
#include "SettingsCatalog.h"
#include "fs/ExternalFileCapabilities.h"
#include "fs/TrashHelper.h"
#include "os/EditorDetection.h"
#include "process/CmdLine.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSet>

namespace {

QString settingsPath(const ChannelServices &services)
{
    return QDir(services.userDataDir).filePath(QStringLiteral("settings.json"));
}

QJsonObject readSettings(const ChannelServices &services)
{
    return readSettingsCatalog(settingsPath(services)).settings;
}

/** Persist one settings patch and return the merged settings (or throw). */
QJsonObject writeSettings(const ChannelServices &services, const QJsonObject &patch)
{
    const SettingsCatalogRead updated = updateSettingsCatalog(settingsPath(services), patch);
    if (!updated.ok) throw ChannelError(updated.error.isEmpty() ? QStringLiteral("Unable to save settings")
                                                               : updated.error);
    return updated.settings;
}

/** Forward one host capability and answer with its result. */
void hostRequest(ChannelServices &services, const QString &method, const QJsonObject &params,
                 ChannelResponder responder, std::function<QJsonValue(const QJsonValue &)> map = {})
{
    if (!services.host) {
        responder.reject(QStringLiteral("Native host bridge is unavailable"));
        return;
    }
    auto request = services.host->request(method, params);
    request->then([responder, map](const QJsonValue &value) mutable {
        responder.resolve(map ? map(value) : value);
    });
    request->fail([responder](const QString &error) mutable { responder.reject(error); });
}

QJsonArray clipboardPaths(const QJsonValue &snapshot)
{
    QJsonArray paths;
    for (const QJsonValue &value : snapshot.toObject().value(QStringLiteral("filePaths")).toArray()) {
        if (value.isString()) paths.append(value);
    }
    return paths;
}

/** `bg-<timestamp><ext>` import with the oracle's name shape and cleanup. */
QString importBackgroundImage(ChannelServices &services, const QString &pickedPath)
{
    if (pickedPath.isEmpty()) return QString();
    const QFileInfo source(pickedPath);
    if (!source.isFile()) return QString();
    const QString extension = source.suffix().isEmpty() ? QString() : QStringLiteral(".") + source.suffix().toLower();
    const QString directory = services.backgroundDir;
    if (!QDir().mkpath(directory)) return QString();
    // Millisecond timestamps can collide when two imports race; keep the name unique.
    qint64 stamp = QDateTime::currentMSecsSinceEpoch();
    QString name = QStringLiteral("bg-%1%2").arg(stamp).arg(extension);
    while (QFileInfo::exists(QDir(directory).filePath(name))) {
        name = QStringLiteral("bg-%1%2").arg(++stamp).arg(extension);
    }
    const QString target = QDir(directory).filePath(name);
    if (!QFile::copy(pickedPath, target)) return QString();
    // Only this directory's own backgrounds are cleaned up. Recycling the previous image
    // is best effort: a failure must not block the new one from taking effect.
    const QFileInfoList existing = QDir(directory).entryInfoList(QStringList{QStringLiteral("bg-*")}, QDir::Files);
    QStringList stale;
    for (const QFileInfo &info : existing) {
        if (info.fileName() != name) stale.append(info.absoluteFilePath());
    }
    if (!stale.isEmpty() && services.host) {
        trashhelper::trashAll(services.host, stale, [](bool, const QString &) {});
    }
    return name;
}

} // namespace

/**
 * Desktop OS capabilities that are not part of a business domain: the native clipboard
 * snapshot, theme background images and external editor discovery.
 *
 * Every capability that touches the OS goes through the Qt host (clipboard, dialogs,
 * recycle bin) using only the host methods the host actually implements.
 */
void registerOsChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("native:clipboard-snapshot"), [&services](const QJsonArray &,
                                                                              ChannelResponder responder) {
        // The renderer pulls the OS clipboard directly when the SSE cache is stale.
        // Paths are a trusted boundary: the answer carries a redeemable capability id
        // instead of free-form paths.
        if (!services.host) {
            responder.reject(QStringLiteral("Native host bridge is unavailable"));
            return;
        }
        auto request = services.host->request(QStringLiteral("clipboard.snapshot"));
        request->then([&services, responder](const QJsonValue &value) mutable {
            QJsonObject snapshot = value.toObject();
            if (!snapshot.contains(QStringLiteral("filePaths"))) snapshot.insert(QStringLiteral("filePaths"), QJsonArray{});
            QStringList paths;
            for (const QJsonValue &path : clipboardPaths(snapshot)) paths.append(path.toString());
            const int sequence = snapshot.value(QStringLiteral("sequence")).toInt(0);
            snapshot.insert(QStringLiteral("externalFileCapabilityId"),
                            services.capabilities ? services.capabilities->issueClipboard(paths, sequence)
                                                  : QString());
            responder.resolve(snapshot);
        });
        request->fail([responder](const QString &error) mutable { responder.reject(error); });
    });

    registry.addAsync(QStringLiteral("backgrounds:pick"), [&services](const QJsonArray &, ChannelResponder responder) {
        hostRequest(services, QStringLiteral("dialog.open"),
                    QJsonObject{
                        {QStringLiteral("title"), QStringLiteral("Select background image")},
                        {QStringLiteral("filters"),
                         QJsonArray{QJsonObject{
                             {QStringLiteral("name"), QStringLiteral("Images")},
                             {QStringLiteral("extensions"),
                              QJsonArray{QStringLiteral("png"), QStringLiteral("jpg"), QStringLiteral("jpeg"),
                                         QStringLiteral("webp"), QStringLiteral("gif"), QStringLiteral("avif")}},
                         }}},
                        {QStringLiteral("properties"), QJsonArray{QStringLiteral("openFile")}},
                        {QStringLiteral("parent"), QStringLiteral("main-window")},
                    },
                    responder, [&services](const QJsonValue &value) {
                        const QJsonObject result = value.toObject();
                        if (result.value(QStringLiteral("canceled")).toBool(false)) return QJsonValue(QStringLiteral(""));
                        const QJsonArray paths = result.value(QStringLiteral("filePaths")).toArray();
                        if (paths.isEmpty()) return QJsonValue(QStringLiteral(""));
                        return QJsonValue(importBackgroundImage(services, paths.first().toString()));
                    });
    });

    registry.addAsync(QStringLiteral("backgrounds:remove"), [&services](const QJsonArray &args,
                                                                       ChannelResponder responder) {
        const QString name = channels::stringArg(args, 0);
        // Only this directory's generated names are removable; anything else is ignored
        // so a renderer-supplied name cannot reach an arbitrary path.
        static const QRegularExpression allowed(QStringLiteral("^bg-[a-zA-Z0-9.]+$"));
        if (!allowed.match(name).hasMatch()) {
            responder.resolve(QJsonValue(QJsonValue::Null));
            return;
        }
        const QString path = QDir(services.backgroundDir).filePath(name);
        if (!QFileInfo::exists(path)) {
            responder.resolve(QJsonValue(QJsonValue::Null));
            return;
        }
        hostRequest(services, QStringLiteral("shell.trashItem"),
                    QJsonObject{{QStringLiteral("path"), path}}, responder,
                    [](const QJsonValue &) { return QJsonValue(QJsonValue::Null); });
    });

    registry.add(QStringLiteral("editors:list"), [&services](const QJsonArray &) {
        return editordetect::listConfiguredEditors(readSettings(services));
    });

    registry.add(QStringLiteral("editors:redetect"), [&services](const QJsonArray &) {
        const QJsonArray detected = editordetect::detectEditors();
        const QJsonObject current = readSettings(services).value(QStringLiteral("externalEditors")).toObject();
        return writeSettings(services, QJsonObject{
                                           {QStringLiteral("externalEditors"),
                                            editordetect::mergeDetectedEditors(current, detected)},
                                       });
    });

    registry.add(QStringLiteral("editors:update"), [&services](const QJsonArray &args) {
        const QString editorId = channels::stringArg(args, 0);
        const QJsonObject patch = channels::objectArg(args, 1);
        const QJsonObject current = readSettings(services).value(QStringLiteral("externalEditors")).toObject();
        const QJsonObject existing = current.value(editorId).toObject();
        if (existing.isEmpty()) throw ChannelError(QStringLiteral("Unsupported editor: %1").arg(editorId));
        QString command = patch.value(QStringLiteral("command")).isString()
            ? patch.value(QStringLiteral("command")).toString().trimmed()
            : existing.value(QStringLiteral("command")).toString();
        if (!command.isEmpty() && !QFileInfo::exists(command)) {
            throw ChannelError(QStringLiteral("Editor path does not exist: %1").arg(command));
        }
        QJsonObject next = existing;
        for (auto iterator = patch.constBegin(); iterator != patch.constEnd(); ++iterator) {
            next.insert(iterator.key(), iterator.value());
        }
        next.insert(QStringLiteral("command"), command);
        next.insert(QStringLiteral("detectedFrom"),
                    patch.contains(QStringLiteral("command"))
                        ? QJsonValue(QStringLiteral("manual"))
                        : existing.value(QStringLiteral("detectedFrom")));
        next.insert(QStringLiteral("updatedAt"), static_cast<double>(QDateTime::currentMSecsSinceEpoch()));
        QJsonObject editors = current;
        editors.insert(editorId, next);
        return writeSettings(services, QJsonObject{{QStringLiteral("externalEditors"), editors}});
    });

    registry.addAsync(QStringLiteral("editors:choose-executable"), [&services](const QJsonArray &,
                                                                              ChannelResponder responder) {
        hostRequest(services, QStringLiteral("dialog.open"),
                    QJsonObject{
                        {QStringLiteral("title"), QStringLiteral("Select editor executable")},
                        {QStringLiteral("filters"),
                         QJsonArray{QJsonObject{
                             {QStringLiteral("name"), QStringLiteral("Applications")},
                             {QStringLiteral("extensions"),
                              QJsonArray{QStringLiteral("exe"), QStringLiteral("cmd"), QStringLiteral("bat")}},
                         }}},
                        {QStringLiteral("properties"), QJsonArray{QStringLiteral("openFile")}},
                        {QStringLiteral("parent"), QStringLiteral("main-window")},
                    },
                    responder, [](const QJsonValue &value) {
                        const QJsonObject result = value.toObject();
                        if (result.value(QStringLiteral("canceled")).toBool(false)) {
                            return QJsonValue(QJsonValue::Null);
                        }
                        const QJsonArray paths = result.value(QStringLiteral("filePaths")).toArray();
                        if (paths.isEmpty()) return QJsonValue(QJsonValue::Null);
                        return QJsonValue(paths.first().toString());
                    });
    });

    registry.addAsync(QStringLiteral("editors:open-project"), [&services](const QJsonArray &args,
                                                                        ChannelResponder responder) {
        const QJsonObject editor = channels::objectArg(args, 0);
        const QString projectPath = channels::stringArg(args, 1);
        if (editor.isEmpty() || projectPath.isEmpty()) {
            responder.reject(QStringLiteral("Invalid editor request"));
            return;
        }
        QStringList editorArgs;
        for (const QJsonValue &value : editor.value(QStringLiteral("args")).toArray()) {
            if (value.isString()) editorArgs.append(value.toString());
        }
        QString error;
        const bool opened = editordetect::openProjectInEditor(
            editor.value(QStringLiteral("id")).toString(), editor.value(QStringLiteral("command")).toString(),
            editorArgs, projectPath, &error);
        if (opened) {
            // Oracle resolves with `undefined` for `Promise<void>`; the wire representation is
            // a JSON null in both backends' result envelope.
            responder.resolve(QJsonValue(QJsonValue::Null));
            return;
        }
        // A GUI editor that cannot be spawned falls back to the OS handler for the folder,
        // which is what the user expects from "open in editor". The oracle only turns that
        // into success when the fallback reports `ok:true`; otherwise it rejects with the
        // original spawn error, so the renderer can toast instead of silently doing nothing.
        if (!services.host) {
            responder.reject(error.isEmpty() ? QStringLiteral("Native host bridge is unavailable") : error);
            return;
        }
        auto request = services.host->request(QStringLiteral("shell.openPath"),
                                              QJsonObject{{QStringLiteral("path"), projectPath}});
        request->then([responder, error](const QJsonValue &value) mutable {
            const QJsonObject result = value.toObject();
            if (result.value(QStringLiteral("ok")).toBool(false)) {
                responder.resolve(QJsonValue(QJsonValue::Null));
                return;
            }
            const QString shellError = result.value(QStringLiteral("error")).toString();
            if (!error.isEmpty()) responder.reject(error);
            else if (!shellError.isEmpty()) responder.reject(shellError);
            else responder.reject(QStringLiteral("Unable to open project folder"));
        });
        request->fail([responder, error](const QString &failure) mutable {
            responder.reject(error.isEmpty() ? failure : error);
        });
    });
}
