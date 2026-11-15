#include "ChannelContext.h"

#include "HostRpcClient.h"
#include "JsonFile.h"
#include "ScratchPad.h"
#include "TrashHelper.h"

#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>

void registerScratchPadChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("scratch-pad:list"), [&services](const QJsonArray &) {
        return QJsonValue(scratchpad::list(services.userDataDir));
    });

    registry.add(QStringLiteral("scratch-pad:create"), [&services](const QJsonArray &) {
        return QJsonValue(scratchpad::create(services.userDataDir));
    });

    // A draft is user content: deletion goes to the recycle bin like every other user
    // file, and an unavailable trash service must fail instead of hard-deleting.
    registry.addAsync(QStringLiteral("scratch-pad:delete"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString path = scratchpad::draftPathFor(channels::stringArg(args, 0));
        if (path.isEmpty()) return responder.reject(QStringLiteral("Draft path is required"));
        if (!scratchpad::insideDrafts(services.userDataDir, path)) {
            return responder.reject(QStringLiteral("Draft path is outside the drafts directory"));
        }
        if (!services.host) return responder.reject(QStringLiteral("Trash service unavailable"));
        trashhelper::trashAll(services.host, QStringList{path},
                              [responder](bool ok, const QString &error) mutable {
            if (!ok) return responder.reject(error);
            responder.resolve(QJsonValue(QJsonValue::Null));
        });
    });

    registry.add(QStringLiteral("scratch-pad:load"), [&services](const QJsonArray &args) {
        const QString path = scratchpad::draftPathFor(channels::stringArg(args, 0));
        if (path.isEmpty()) return QJsonValue(scratchpad::load(QString()));
        if (!scratchpad::insideDrafts(services.userDataDir, path)) {
            throw ChannelError(QStringLiteral("Draft path is outside the drafts directory"));
        }
        return QJsonValue(scratchpad::load(path));
    });

    registry.add(QStringLiteral("scratch-pad:save"), [&services](const QJsonArray &args) {
        const QString path = scratchpad::draftPathFor(channels::stringArg(args, 0));
        if (path.isEmpty()) throw ChannelError(QStringLiteral("Draft path is required"));
        if (!scratchpad::insideDrafts(services.userDataDir, path)) {
            throw ChannelError(QStringLiteral("Draft path is outside the drafts directory"));
        }
        scratchpad::save(services.userDataDir, path, channels::stringArg(args, 1));
        return QJsonValue(QJsonValue::Null);
    });

    // Export asks the host for a destination; a cancelled dialog is `false`, not an error.
    registry.addAsync(QStringLiteral("scratch-pad:export"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString path = scratchpad::draftPathFor(channels::stringArg(args, 0));
        if (path.isEmpty()) return responder.resolve(false);
        if (!scratchpad::insideDrafts(services.userDataDir, path)) return responder.resolve(false);
        if (!services.host) return responder.resolve(false);
        const QJsonObject params{
            {QStringLiteral("defaultPath"), QFileInfo(path).fileName()},
            {QStringLiteral("filters"),
             QJsonArray{QJsonObject{{QStringLiteral("name"), QStringLiteral("Markdown")},
                                    {QStringLiteral("extensions"), QJsonArray{QStringLiteral("md")}}}}},
        };
        auto request = services.host->request(QStringLiteral("dialog.save"), params);
        request->then([path, responder](const QJsonValue &value) mutable {
            const QJsonObject result = value.toObject();
            const QString target = result.value(QStringLiteral("filePath")).toString();
            if (result.value(QStringLiteral("canceled")).toBool() || target.isEmpty()) {
                return responder.resolve(false);
            }
            QString content;
            if (!jsonfile::readText(path, &content)) return responder.resolve(false);
            QString error;
            if (!jsonfile::writeBytesAtomic(target, content.toUtf8(), &error)) {
                return responder.reject(error);
            }
            responder.resolve(true);
        });
        request->fail([responder](const QString &error) mutable { responder.reject(error); });
    });
}
