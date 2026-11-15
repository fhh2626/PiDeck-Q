#include "ChannelContext.h"

#include "SkillManager.h"

#include "../fs/TrashHelper.h"
#include "HostRpcClient.h"

#include <QJsonObject>

/**
 * `skills:*` channels.
 *
 * Port of the skill half of src/main/ipc/storeIpc.ts. Validation is limited to the wire
 * shape; discovery, frontmatter toggling and the no-clobber rename live in
 * `skills::Manager` so they are testable without the RPC surface.
 */
namespace {

skills::Manager &manager(const ChannelServices &services)
{
    if (!services.skills) throw ChannelError(QStringLiteral("Skill manager is not available"));
    return *services.skills;
}

QString requireSkillPath(const QJsonArray &args, int index)
{
    const QString value = channels::stringArg(args, index);
    if (value.trimmed().isEmpty()) {
        throw ChannelError(QStringLiteral("skillPath must be a non-empty string."));
    }
    return value;
}

void openInHost(const ChannelServices &services, const QString &path, ChannelResponder responder)
{
    if (!services.host) {
        responder.reject(QStringLiteral("Host bridge is not available"));
        return;
    }
    auto request = services.host->request(QStringLiteral("shell.openPath"),
                                          QJsonObject{{QStringLiteral("path"), path}});
    request->then([responder](const QJsonValue &) mutable {
        responder.resolve(QJsonValue(QJsonValue::Undefined));
    });
    request->fail([responder](const QString &error) mutable { responder.reject(error); });
}

} // namespace

void registerSkillChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("skills:list"), [&services](const QJsonArray &) {
        return QJsonValue(skills::listToJson(manager(services).list()));
    });

    registry.add(QStringLiteral("skills:create"), [&services](const QJsonArray &args) {
        const QJsonObject input = channels::objectArg(args, 0);
        const QJsonValue name = input.value(QStringLiteral("name"));
        const QJsonValue description = input.value(QStringLiteral("description"));
        if (!name.isString() || !description.isString()) {
            throw ChannelError(QStringLiteral("Skill input is invalid"));
        }
        const QString locationId = input.value(QStringLiteral("locationId")).toString();
        const skills::Summary created = manager(services).create(
            name.toString(), description.toString(),
            locationId.isEmpty() ? QStringLiteral("pi-global") : locationId);
        return QJsonValue(skills::summaryToJson(created));
    });

    registry.add(QStringLiteral("skills:toggle"), [&services](const QJsonArray &args) {
        const QString skillPath = requireSkillPath(args, 0);
        const QJsonValue enabled = channels::argAt(args, 1);
        if (!enabled.isBool()) throw ChannelError(QStringLiteral("enabled must be a boolean."));
        return QJsonValue(
            skills::summaryToJson(manager(services).toggle(skillPath, enabled.toBool())));
    });

    registry.addAsync(QStringLiteral("skills:delete"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString skillPath = channels::stringArg(args, 0);
                          skills::DeleteTarget target;
                          try {
                              target = manager(services).prepareDelete(skillPath);
                          } catch (const std::exception &failure) {
                              responder.reject(QString::fromUtf8(failure.what()));
                              return;
                          }
                          trashhelper::trashAll(
                              services.host, QStringList{target.path},
                              [responder](bool ok, const QString &error) mutable {
                                  if (!ok) responder.reject(error);
                                  else responder.resolve(QJsonValue(QJsonValue::Undefined));
                              });
                      });

    registry.addAsync(QStringLiteral("skills:open-folder"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          // The optional argument is a skill path; without it the first
                          // managed root opens (the oracle's "open skills folder").
                          QString path;
                          try {
                              path = manager(services).folderToOpen(channels::stringArg(args, 0));
                          } catch (const std::exception &failure) {
                              responder.reject(QString::fromUtf8(failure.what()));
                              return;
                          }
                          openInHost(services, path, responder);
                      });

    registry.add(QStringLiteral("skills:rename"), [&services](const QJsonArray &args) {
        const QString skillPath = requireSkillPath(args, 0);
        const skills::Summary renamed =
            manager(services).rename(skillPath, channels::stringArg(args, 1));
        return QJsonValue(skills::summaryToJson(renamed));
    });
}
