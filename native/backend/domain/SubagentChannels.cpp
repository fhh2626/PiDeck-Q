#include "ChannelContext.h"

#include "ProjectStore.h"
#include "SubagentSettings.h"

#include <QJsonArray>
#include <QJsonObject>

namespace {

/** Project id is only meaningful for the project scope; an empty value means "none". */
QString projectPathFor(const ChannelServices &services, const QJsonValue &projectId)
{
    if (!projectId.isString() || projectId.toString().isEmpty()) return {};
    if (!services.projects) return {};
    const QJsonObject project = services.projects->get(projectId.toString());
    return project.value(QStringLiteral("path")).toString();
}

} // namespace

void registerSubagentChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("subagents:get-settings"), [&services](const QJsonArray &args) {
        const QJsonValue projectId = channels::argAt(args, 0);
        if (!projectId.isNull() && !projectId.isUndefined() && !projectId.isString()) {
            throw ChannelError(QStringLiteral("projectId must be a string"));
        }
        return QJsonValue(subagents::read(services.agentDir,
                                          projectPathFor(services, projectId)));
    });

    registry.add(QStringLiteral("subagents:save-settings"), [&services](const QJsonArray &args) {
        const QJsonValue scopeValue = channels::argAt(args, 0);
        if (!scopeValue.isString()
            || (scopeValue.toString() != QStringLiteral("global")
                && scopeValue.toString() != QStringLiteral("project"))) {
            throw ChannelError(QStringLiteral("scope must be \"global\" or \"project\""));
        }
        const QJsonValue projectId = channels::argAt(args, 1);
        if (!projectId.isNull() && !projectId.isUndefined() && !projectId.isString()) {
            throw ChannelError(QStringLiteral("projectId must be a string"));
        }
        const QString path = projectPathFor(services, projectId);
        // A project-scope save without a project would land in the global file.
        if (scopeValue.toString() == QStringLiteral("project") && path.isEmpty()) {
            throw ChannelError(QStringLiteral("projectId is required for project scope"));
        }
        try {
            subagents::save(services.agentDir, path, scopeValue.toString(),
                            channels::argAt(args, 2));
        } catch (const std::exception &error) {
            throw ChannelError(QString::fromUtf8(error.what()));
        }
        return QJsonValue(QJsonObject{{QStringLiteral("ok"), true}});
    });
}
