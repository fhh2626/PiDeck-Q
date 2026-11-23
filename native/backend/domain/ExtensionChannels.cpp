#include "ChannelContext.h"

#include "ExtensionManager.h"
#include "extensions/BuiltInExtensions.h"

#include "../fs/TrashHelper.h"
#include "../../process/BackgroundWork.h"

#include <QJsonObject>

/**
 * `extensions:*` channels.
 *
 * Every handler that spawns `pi`/`npm` runs through `background::runBlocking`: the Node
 * oracle awaits `execFile`, so a 120 s `pi update` must not stall the renderer RPC, the
 * SSE stream or the host bridge.
 */
namespace {

extensions::Manager &manager(const ChannelServices &services)
{
    if (!services.extensions) throw ChannelError(QStringLiteral("Extension manager is not available"));
    return *services.extensions;
}

/** Run a manager call off the event loop and settle the channel with its result. */
void runOffThread(std::function<QJsonValue()> task, ChannelResponder responder)
{
    background::runBlocking(std::move(task), [responder](background::Outcome outcome) mutable {
        if (!outcome.ok) responder.reject(outcome.error);
        else responder.resolve(outcome.value);
    });
}

} // namespace

void registerExtensionChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("extensions:list"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const bool forceRefresh = channels::argAt(args, 0).toBool(false);
                          runOffThread(
                              [&services, forceRefresh]() {
                                  return QJsonValue(extensions::listToJson(
                                      manager(services).list(forceRefresh)));
                              },
                              responder);
                      });

    registry.addAsync(QStringLiteral("extensions:install"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString source = channels::stringArg(args, 0);
                          runOffThread(
                              [&services, source]() {
                                  return QJsonValue(manager(services).install(source));
                              },
                              responder);
                      });

    registry.addAsync(QStringLiteral("extensions:uninstall"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString source = channels::stringArg(args, 0);
                          const QString scope = channels::stringArg(args, 1);
                          // The manager call runs off-thread; the recycle-bin request is a
                          // host round trip, so it happens in the continuation.
                          background::runBlocking(
                              [&services, source, scope]() {
                                  const QString target = manager(services).uninstall(
                                      source, scope.isEmpty() ? QStringLiteral("user") : scope);
                                  return QJsonValue(target);
                              },
                              [&services, responder](background::Outcome outcome) mutable {
                                  if (!outcome.ok) {
                                      responder.reject(outcome.error);
                                      return;
                                  }
                                  const QString target = outcome.value.toString();
                                  if (target.isEmpty()) {
                                      responder.resolve(QJsonValue(QJsonValue::Undefined));
                                      return;
                                  }
                                  trashhelper::trashAll(
                                      services.host, QStringList{target},
                                      [responder](bool ok, const QString &error) mutable {
                                          if (!ok) responder.reject(error);
                                          else responder.resolve(QJsonValue(QJsonValue::Undefined));
                                      });
                              });
                      });

    registry.addAsync(QStringLiteral("extensions:toggle"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString source = channels::stringArg(args, 0);
                          const QJsonValue enabled = channels::argAt(args, 1);
                          if (!enabled.isBool()) {
                              responder.reject(QStringLiteral("enabled must be a boolean."));
                              return;
                          }
                          const bool value = enabled.toBool();
                          // A built-in is controlled by PiDeck's removed list (pi skips it
                          // at launch); a package goes through pi's disabledExtensions.
                          runOffThread(
                              [&services, source, value]() {
                                  extensions::Manager &extensions = manager(services);
                                  if (builtext::isBuiltInName(source)) {
                                      if (value) extensions.restoreBuiltIn(source);
                                      else extensions.removeBuiltIn(source);
                                  } else {
                                      extensions.setEnabled(source, value);
                                  }
                                  return QJsonValue(QJsonValue::Undefined);
                              },
                              responder);
                      });

    registry.addAsync(QStringLiteral("extensions:remove-built-in"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString source = channels::stringArg(args, 0);
                          runOffThread(
                              [&services, source]() {
                                  manager(services).removeBuiltIn(source);
                                  return QJsonValue(QJsonValue::Undefined);
                              },
                              responder);
                      });

    registry.addAsync(QStringLiteral("extensions:restore-built-in"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString source = channels::stringArg(args, 0);
                          runOffThread(
                              [&services, source]() {
                                  manager(services).restoreBuiltIn(source);
                                  return QJsonValue(QJsonValue::Undefined);
                              },
                              responder);
                      });

    registry.addAsync(QStringLiteral("extensions:update"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
                          runOffThread(
                              [&services]() {
                                  const extensions::UpdateResult result =
                                      manager(services).updateAll();
                                  return QJsonValue(QJsonObject{
                                      {QStringLiteral("command"), result.command},
                                      {QStringLiteral("output"), result.output},
                                      {QStringLiteral("updated"), result.updated},
                                  });
                              },
                              responder);
                      });

    registry.addAsync(QStringLiteral("extensions:update-one"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString source = channels::stringArg(args, 0);
                          runOffThread(
                              [&services, source]() {
                                  const extensions::UpdateResult result =
                                      manager(services).updateOne(source);
                                  return QJsonValue(QJsonObject{
                                      {QStringLiteral("command"), result.command},
                                      {QStringLiteral("output"), result.output},
                                      {QStringLiteral("updated"), result.updated},
                                  });
                              },
                              responder);
                      });
}
