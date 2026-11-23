#include "ChannelContext.h"

#include "PromptManager.h"

#include "../fs/TrashHelper.h"
#include "HostRpcClient.h"

#include <QDir>
#include <QJsonObject>

/**
 * `prompts:*` channels.
 *
 * Port of the prompt-template half of src/main/ipc/storeIpc.ts. The handlers only
 * validate the wire shape and forward to `prompts::Manager`; every rule (authorization,
 * built-in hiding, no-clobber rename) lives in the manager so it can be unit tested
 * without the RPC surface.
 */
namespace {

/** `assertNonEmptyString(field)` from the oracle: a TypeError with the field name. */
QString requireNonEmptyString(const QJsonArray &args, int index, const QString &field)
{
    const QString value = channels::stringArg(args, index);
    if (value.trimmed().isEmpty()) {
        throw ChannelError(QStringLiteral("%1 must be a non-empty string.").arg(field));
    }
    return value;
}

QJsonObject requireCreateInput(const QJsonArray &args, int index)
{
    const QJsonObject input = channels::objectArg(args, index);
    if (!input.value(QStringLiteral("name")).isString()
        || !input.value(QStringLiteral("description")).isString()) {
        throw ChannelError(QStringLiteral("Prompt template input is invalid"));
    }
    return input;
}

prompts::Manager &manager(const ChannelServices &services)
{
    if (!services.prompts) throw ChannelError(QStringLiteral("Prompt manager is not available"));
    return *services.prompts;
}

/** Trash the prepared target (a built-in is hidden in settings instead). */
void trashOrResolve(const ChannelServices &services, const prompts::DeleteTarget &target,
                    ChannelResponder responder)
{
    if (target.handledInSettings) {
        responder.resolve(QJsonValue(QJsonValue::Undefined));
        return;
    }
    trashhelper::trashAll(services.host, QStringList{target.path},
                          [responder](bool ok, const QString &error) mutable {
                              if (!ok) responder.reject(error);
                              else responder.resolve(QJsonValue(QJsonValue::Undefined));
                          });
}

} // namespace

void registerStoreChannels(ChannelRegistry &registry, ChannelServices &services);

void registerPromptChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("prompts:list"), [&services](const QJsonArray &) {
        return QJsonValue(prompttpl::listToJson(manager(services).list()));
    });

    registry.add(QStringLiteral("prompts:create"), [&services](const QJsonArray &args) {
        const QJsonObject input = requireCreateInput(args, 0);
        const prompttpl::Template created = manager(services).create(
            input.value(QStringLiteral("name")).toString(),
            input.value(QStringLiteral("description")).toString());
        return QJsonValue(prompttpl::toJson(created));
    });

    registry.addAsync(QStringLiteral("prompts:delete"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString filePath = requireNonEmptyString(args, 0, QStringLiteral("filePath"));
                          prompts::DeleteTarget target;
                          try {
                              target = manager(services).prepareDelete(filePath);
                          } catch (const std::exception &failure) {
                              responder.reject(QString::fromUtf8(failure.what()));
                              return;
                          }
                          trashOrResolve(services, target, responder);
                      });

    registry.addAsync(QStringLiteral("prompts:open-folder"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
                          const QString directory = manager(services).ensureDir();
                          if (!services.host) {
                              responder.reject(QStringLiteral("Host bridge is not available"));
                              return;
                          }
                          auto request = services.host->request(
                              QStringLiteral("shell.openPath"),
                              QJsonObject{{QStringLiteral("path"), directory}});
                          request->then([responder](const QJsonValue &) mutable {
                              responder.resolve(QJsonValue(QJsonValue::Undefined));
                          });
                          request->fail([responder](const QString &error) mutable {
                              responder.reject(error);
                          });
                      });

    registry.add(QStringLiteral("prompts:restore-builtins"), [&services](const QJsonArray &) {
        manager(services).restoreHiddenBuiltins();
        return QJsonValue(QJsonValue::Undefined);
    });

    // `prompts:edit` is a read when `content` is absent and a write when it is present.
    registry.add(QStringLiteral("prompts:edit"), [&services](const QJsonArray &args) {
        const QString filePath = requireNonEmptyString(args, 0, QStringLiteral("filePath"));
        const QJsonValue content = channels::argAt(args, 1);
        if (content.isUndefined() || content.isNull()) {
            return QJsonValue(manager(services).readContent(filePath));
        }
        if (!content.isString()) throw ChannelError(QStringLiteral("content must be a string."));
        manager(services).writeContent(filePath, content.toString());
        return QJsonValue(QJsonValue::Undefined);
    });

    registry.add(QStringLiteral("prompts:list-by-project"), [&services](const QJsonArray &args) {
        const QString projectPath = requireNonEmptyString(args, 0, QStringLiteral("projectPath"));
        return QJsonValue(prompttpl::listToJson(manager(services).listByProject(projectPath)));
    });

    registry.add(QStringLiteral("prompts:create-in-project"), [&services](const QJsonArray &args) {
        const QString projectPath = requireNonEmptyString(args, 0, QStringLiteral("projectPath"));
        const QJsonObject input = requireCreateInput(args, 1);
        const prompttpl::Template created = manager(services).createInProject(
            projectPath, input.value(QStringLiteral("name")).toString(),
            input.value(QStringLiteral("description")).toString());
        return QJsonValue(prompttpl::toJson(created));
    });

    registry.addAsync(QStringLiteral("prompts:delete-in-project"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString projectPath =
                              requireNonEmptyString(args, 0, QStringLiteral("projectPath"));
                          const QString fileName =
                              requireNonEmptyString(args, 1, QStringLiteral("fileName"));
                          prompts::DeleteTarget target;
                          try {
                              target = manager(services).prepareDeleteInProject(projectPath, fileName);
                          } catch (const std::exception &failure) {
                              responder.reject(QString::fromUtf8(failure.what()));
                              return;
                          }
                          trashOrResolve(services, target, responder);
                      });

    registry.add(QStringLiteral("prompts:rename"), [&services](const QJsonArray &args) {
        const prompttpl::Template renamed = manager(services).rename(
            channels::stringArg(args, 0), channels::stringArg(args, 1));
        return QJsonValue(prompttpl::toJson(renamed));
    });

    registry.add(QStringLiteral("prompts:rename-in-project"), [&services](const QJsonArray &args) {
        const QString projectPath = requireNonEmptyString(args, 0, QStringLiteral("projectPath"));
        const prompttpl::Template renamed = manager(services).renameInProject(
            projectPath, channels::stringArg(args, 1), channels::stringArg(args, 2));
        return QJsonValue(prompttpl::toJson(renamed));
    });
}
