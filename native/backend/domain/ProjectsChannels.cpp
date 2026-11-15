#include "ChannelContext.h"

#include "BackgroundWork.h"
#include "EventHub.h"
#include "RuntimeCoordinator.h"
#include "SessionCatalogStore.h"
#include "GitService.h"
#include "GitWorktree.h"
#include "HostRpcClient.h"
#include "ModelSpecs.h"
#include "ProjectRecord.h"
#include "ProjectResources.h"
#include "ProjectStore.h"
#include "SettingsCatalog.h"
#include "TrashHelper.h"

#include <QDir>
#include <QJsonArray>
#include <QJsonObject>

namespace {

QJsonObject settingsObject(const ChannelServices &services)
{
    return readSettingsCatalog(QDir(services.userDataDir).filePath(QStringLiteral("settings.json")))
        .settings;
}

/** True when any live pi process belongs to a session of this project. */
bool projectHasRunningAgent(const ChannelServices &services, const QString &projectId)
{
    if (!services.runtimeCoordinator || !services.catalog) return false;
    for (const QJsonValue &value : services.runtimeCoordinator->agentProcesses()) {
        const QString sessionId =
            value.toObject().value(QStringLiteral("sessionId")).toString();
        if (sessionId.isEmpty()) continue;
        bool found = false;
        const QJsonObject record = services.catalog->getRecord(sessionId, &found);
        if (!found) continue;
        if (record.value(QStringLiteral("projectId")).toString() == projectId) return true;
    }
    return false;
}

projectresources::Manager resourceManager(const ChannelServices &services)
{
    projects::Store *store = services.projects;
    return projectresources::Manager(
        [store](const QString &projectId) {
            return store ? store->get(projectId) : QJsonObject{};
        },
        services.translate);
}

} // namespace

void registerProjectChannels(ChannelRegistry &registry, ChannelServices &services)
{
    // ── catalog ───────────────────────────────────────────────────────────────

    registry.add(QStringLiteral("projects:list"), [&services](const QJsonArray &) {
        if (!services.projects) return QJsonValue(QJsonArray{});
        return QJsonValue(services.projects->visibleRecords(settingsObject(services)));
    });

    // The renderer never names a directory: the folder comes from the host dialog, so
    // `projects:add` cannot become an arbitrary-path primitive.
    registry.addAsync(QStringLiteral("projects:add"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
        if (!services.host) return responder.reject(QStringLiteral("Native host bridge is unavailable"));
        if (!services.projects) return responder.reject(QStringLiteral("Project catalog is unavailable"));
        const QJsonObject settings = settingsObject(services);
        const bool wsl = settings.value(QStringLiteral("wslEnabled")).toBool();
        QJsonObject params{
            {QStringLiteral("title"),
             services.translate(QStringLiteral("dialog.chooseProjectFolder"), {})},
            {QStringLiteral("properties"), QJsonArray{QStringLiteral("openDirectory")}},
        };
        auto request = services.host->request(QStringLiteral("dialog.open"), params);
        request->then([&services, responder, wsl](const QJsonValue &value) mutable {
            const QJsonArray paths = value.toObject().value(QStringLiteral("filePaths")).toArray();
            if (paths.isEmpty()) return responder.resolve(QJsonValue(QJsonValue::Null));
            try {
                const QJsonObject project = services.projects->add(
                    paths.at(0).toString(), QString(),
                    wsl ? QStringLiteral("wsl") : QStringLiteral("windows"));
                responder.resolve(project);
            } catch (const std::exception &error) {
                responder.reject(QString::fromUtf8(error.what()));
            }
        });
        request->fail([responder](const QString &error) mutable { responder.reject(error); });
    });

    registry.add(QStringLiteral("projects:remove"), [&services](const QJsonArray &args) {
        if (!services.projects) throw ChannelError(QStringLiteral("Project catalog is unavailable"));
        const QString projectId = channels::stringArg(args, 0);
        // A project whose pi process is still running cannot be removed: the process
        // would keep the folder busy with no UI left to stop it.
        if (projectHasRunningAgent(services, projectId)) {
            throw ChannelError(QStringLiteral("PROJECT_HAS_RUNNING_AGENT"));
        }
        services.projects->remove(projectId);
        return QJsonValue(services.projects->visibleRecords(settingsObject(services)));
    });

    registry.add(QStringLiteral("projects:reorder"), [&services](const QJsonArray &args) {
        if (!services.projects) throw ChannelError(QStringLiteral("Project catalog is unavailable"));
        QStringList ids;
        for (const QJsonValue &value : channels::argAt(args, 0).toArray()) {
            if (value.isString()) ids.append(value.toString());
        }
        services.projects->reorder(ids);
        return QJsonValue(services.projects->visibleRecords(settingsObject(services)));
    });

    registry.add(QStringLiteral("projects:list-root"), [&services](const QJsonArray &) {
        if (!services.projects) return QJsonValue(QJsonArray{});
        return QJsonValue(services.projects->listRoot());
    });

    registry.add(QStringLiteral("projects:list-worktree-children"), [&services](const QJsonArray &args) {
        if (!services.projects) return QJsonValue(QJsonArray{});
        return QJsonValue(services.projects->listWorktreeChildren(channels::stringArg(args, 0)));
    });

    registry.addAsync(QStringLiteral("projects:toggle-worktree-enabled"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        if (!services.projects) return responder.reject(QStringLiteral("Project catalog is unavailable"));
        const QString projectId = channels::stringArg(args, 0);
        const QJsonObject existing = services.projects->get(projectId);
        if (existing.isEmpty()) {
            return responder.reject(QStringLiteral("Project not found: %1").arg(projectId));
        }
        background::runBlocking(
            [&services, projectId, existing]() -> QJsonValue {
                // Enabling workspace mode on a non-repository only produces an empty list
                // and an error on create, so the check happens before the toggle.
                if (!existing.value(QStringLiteral("worktreeEnabled")).toBool()) {
                    if (!gitservice::isGitRepo(existing.value(QStringLiteral("path")).toString())) {
                        throw ChannelError(QStringLiteral("NOT_A_GIT_REPO"));
                    }
                }
                const QJsonObject project = services.projects->toggleWorktreeEnabled(projectId);
                if (project.isEmpty()) {
                    throw ChannelError(QStringLiteral("Project not found: %1").arg(projectId));
                }
                // Register worktrees that already exist so the sidebar shows them at once.
                if (project.value(QStringLiteral("worktreeEnabled")).toBool()) {
                    try {
                        for (const gitworktree::Entry &entry :
                             gitworktree::list(project.value(QStringLiteral("path")).toString())) {
                            if (services.projects->findByPath(entry.path).isEmpty()) {
                                services.projects->add(entry.path, projectId);
                            }
                        }
                    } catch (const std::exception &) {
                        // A failing worktree query must not block the toggle.
                    }
                }
                return project;
            },
            [responder](const background::Outcome &outcome) mutable {
                if (!outcome.ok) return responder.reject(outcome.error);
                responder.resolve(outcome.value);
            });
    });

    // ── chat directory ────────────────────────────────────────────────────────

    registry.addAsync(QStringLiteral("projects:choose-chat-path"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
        if (!services.host) return responder.reject(QStringLiteral("Native host bridge is unavailable"));
        if (!services.projects) return responder.reject(QStringLiteral("Project catalog is unavailable"));
        QJsonObject params{
            {QStringLiteral("title"),
             services.translate(QStringLiteral("dialog.chooseChatHistoryFolder"), {})},
            {QStringLiteral("defaultPath"), services.projects->chatProjectPath()},
            {QStringLiteral("properties"), QJsonArray{QStringLiteral("openDirectory")}},
        };
        auto request = services.host->request(QStringLiteral("dialog.open"), params);
        request->then([responder](const QJsonValue &value) mutable {
            const QJsonArray paths = value.toObject().value(QStringLiteral("filePaths")).toArray();
            if (paths.isEmpty()) return responder.resolve(QJsonValue(QJsonValue::Null));
            responder.resolve(paths.at(0).toString());
        });
        request->fail([responder](const QString &error) mutable { responder.reject(error); });
    });

    registry.add(QStringLiteral("projects:set-chat-path"), [&services](const QJsonArray &args) {
        if (!services.projects) throw ChannelError(QStringLiteral("Project catalog is unavailable"));
        const QString path = channels::stringArg(args, 0);
        if (path.isEmpty()) throw ChannelError(QStringLiteral("Invalid chat path"));
        const QJsonObject project = services.projects->setChatProjectPath(path);
        // The renderer refreshes the chat project's sessions from this broadcast.
        if (services.events) {
            services.events->broadcast(QStringLiteral("projects:changed"),
                                       QJsonArray{QJsonValue(services.projects->visibleRecords(settingsObject(services)))});
        }
        return QJsonValue(project.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(project));
    });

    // ── model specs ───────────────────────────────────────────────────────────

    registry.add(QStringLiteral("projects:get-model-spec"), [&services](const QJsonArray &args) {
        const QJsonValue provider = channels::argAt(args, 0);
        const QJsonValue modelId = channels::argAt(args, 1);
        // Boundary validation: the renderer cannot widen the query with a huge key.
        if (!provider.isString() || !modelId.isString() || provider.toString().size() > 128
            || modelId.toString().size() > 256) {
            return QJsonValue(QJsonValue::Null);
        }
        const QJsonValue spec =
            modelspecs::lookup(services.resourcesDir, provider.toString(), modelId.toString());
        return spec;
    });

    // ── project resources ─────────────────────────────────────────────────────

    registry.add(QStringLiteral("project-resources:list"), [&services](const QJsonArray &args) {
        return resourceManager(services).list(channels::stringArg(args, 0));
    });

    registry.add(QStringLiteral("project-resources:create-skill"),
                 [&services](const QJsonArray &args) {
        const QJsonObject input = channels::objectArg(args, 0);
        return resourceManager(services).createSkill(
            input.value(QStringLiteral("projectId")).toString(),
            input.value(QStringLiteral("name")).toString(),
            input.value(QStringLiteral("description")).toString());
    });

    registry.addAsync(QStringLiteral("project-resources:delete-skill"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        try {
            resourceManager(services).deleteSkill(
                channels::stringArg(args, 0), channels::stringArg(args, 1), services.host,
                [responder](bool ok, const QString &error) mutable {
                    if (!ok) return responder.reject(error);
                    responder.resolve(QJsonValue(QJsonValue::Null));
                });
        } catch (const std::exception &error) {
            responder.reject(QString::fromUtf8(error.what()));
        }
    });

    registry.addAsync(QStringLiteral("project-resources:delete-extension"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        try {
            resourceManager(services).deleteExtension(
                channels::stringArg(args, 0), channels::stringArg(args, 1), services.host,
                [responder](bool ok, const QString &error) mutable {
                    if (!ok) return responder.reject(error);
                    responder.resolve(QJsonValue(QJsonValue::Null));
                });
        } catch (const std::exception &error) {
            responder.reject(QString::fromUtf8(error.what()));
        }
    });

    registry.add(QStringLiteral("project-resources:toggle-skill"),
                 [&services](const QJsonArray &args) {
        return resourceManager(services).toggleSkill(
            channels::stringArg(args, 0), channels::stringArg(args, 1),
            channels::argAt(args, 2).toBool());
    });

    registry.add(QStringLiteral("project-resources:toggle-extension"),
                 [&services](const QJsonArray &args) {
        resourceManager(services).toggleExtension(
            channels::stringArg(args, 0), channels::stringArg(args, 1),
            channels::argAt(args, 2).toBool());
        return QJsonValue(QJsonValue::Null);
    });

    registry.add(QStringLiteral("project-resources:rename-skill"),
                 [&services](const QJsonArray &args) {
        return resourceManager(services).renameSkill(
            channels::stringArg(args, 0), channels::stringArg(args, 1),
            channels::stringArg(args, 2));
    });

    // ── trust ─────────────────────────────────────────────────────────────────

    // The trust prompt is answered by the renderer; the pending request lives in the
    // runtime coordinator, which is the only owner of the pi process that asked.
    registry.add(QStringLiteral("projects:trust-response"), [&services](const QJsonArray &args) {
        const QString requestId = channels::stringArg(args, 0);
        const QString choice = channels::stringArg(args, 1);
        if (requestId.isEmpty()) throw ChannelError(QStringLiteral("Invalid trust request id"));
        if (choice != QStringLiteral("trust-remember") && choice != QStringLiteral("trust-session")
            && choice != QStringLiteral("deny")) {
            throw ChannelError(QStringLiteral("Invalid trust choice"));
        }
        if (services.runtimeCoordinator) {
            services.runtimeCoordinator->respondTrustRequest(requestId, choice);
        }
        return QJsonValue(QJsonValue::Null);
    });
}
