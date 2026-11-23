#include "GitChannelParts.h"

#include "BackgroundWork.h"
#include "GitHistory.h"
#include "GitService.h"
#include "GitStatusContext.h"
#include "GitWorktree.h"
#include "ProjectStore.h"
#include "ProjectResolver.h"

#include <QJsonArray>
#include <QJsonObject>

namespace {

using background::Outcome;

void settle(ChannelResponder responder, const Outcome &outcome)
{
    if (outcome.ok) responder.resolve(outcome.value);
    else responder.reject(outcome.error);
}

QJsonObject emptyGroups()
{
    return QJsonObject{
        {QStringLiteral("merge"), QJsonArray{}},
        {QStringLiteral("index"), QJsonArray{}},
        {QStringLiteral("untracked"), QJsonArray{}},
        {QStringLiteral("workingTree"), QJsonArray{}},
    };
}

githistory::LogOptions logOptions(const QJsonValue &value)
{
    githistory::LogOptions options;
    const QJsonObject object = value.toObject();
    if (object.value(QStringLiteral("maxEntries")).isDouble()) {
        options.maxEntries = object.value(QStringLiteral("maxEntries")).toInt(32);
    }
    options.ref = object.value(QStringLiteral("ref")).toString();
    options.path = object.value(QStringLiteral("path")).toString();
    // The history panel shows all branches by default.
    options.allBranches = object.value(QStringLiteral("allBranches")).toBool(true);
    return options;
}

/**
 * Run `task` off the event loop and settle the channel from its result.
 * `projectPath` resolution happens inside the task so a slow projects.json read never
 * blocks the renderer.
 */
void runGit(ChannelResponder responder, std::function<QJsonValue()> task)
{
    background::runBlocking(std::move(task), [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
}

} // namespace

void registerGitReadChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("git:branches"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        runGit(responder, [&services, projectId]() -> QJsonValue {
            return gitservice::getBranches(channels::resolveProjectPath(services, projectId));
        });
    });

    registry.addAsync(QStringLiteral("git:commit-log"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const githistory::LogOptions options = logOptions(channels::argAt(args, 1));
        runGit(responder, [&services, projectId, options]() -> QJsonValue {
            // A missing project yields an empty history rather than an error, matching
            // the oracle so the panel degrades instead of showing a failure.
            projectresolver::Project project;
            if (!projectresolver::findById(channels::projectsFile(services), projectId, &project)) return QJsonArray{};
            return githistory::getCommitLog(project.path, options);
        });
    });

    registry.addAsync(QStringLiteral("git:refs"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        runGit(responder, [&services, projectId]() -> QJsonValue {
            projectresolver::Project project;
            if (!projectresolver::findById(channels::projectsFile(services), projectId, &project)) return QJsonArray{};
            return githistory::getRefs(project.path);
        });
    });

    registry.addAsync(QStringLiteral("git:branch-compare"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString base = channels::stringArg(args, 1);
        const QString target = channels::stringArg(args, 2);
        runGit(responder, [&services, projectId, base, target]() -> QJsonValue {
            return githistory::compareBranches(channels::resolveProjectPath(services, projectId), base, target);
        });
    });

    registry.addAsync(QStringLiteral("git:commit-detail"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString ref = channels::stringArg(args, 1);
        runGit(responder, [&services, projectId, ref]() -> QJsonValue {
            projectresolver::Project project;
            if (!projectresolver::findById(channels::projectsFile(services), projectId, &project)) {
                return QJsonValue(QJsonValue::Null);
            }
            return githistory::getCommitDetail(project.path, ref);
        });
    });

    registry.addAsync(QStringLiteral("git:commit-file-diff"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString ref = channels::stringArg(args, 1);
        const QString filePath = channels::stringArg(args, 2);
        const QJsonValue originalValue = channels::argAt(args, 3);
        const QString originalPath = originalValue.toString();
        const bool hasOriginalPath = originalValue.isString();
        runGit(responder, [&services, projectId, ref, filePath, originalPath, hasOriginalPath]() -> QJsonValue {
            projectresolver::Project project;
            if (!projectresolver::findById(channels::projectsFile(services), projectId, &project)) {
                return QJsonValue(QJsonValue::Null);
            }
            return githistory::getCommitFileDiff(project.path, ref, filePath, originalPath, hasOriginalPath,
                                                 channels::maxEditorFileBytes(services));
        });
    });

    registry.addAsync(QStringLiteral("git:diff-file-between"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString ref1 = channels::stringArg(args, 1);
        const QString ref2 = channels::stringArg(args, 2);
        const QString filePath = channels::stringArg(args, 3);
        runGit(responder, [&services, projectId, ref1, ref2, filePath]() -> QJsonValue {
            projectresolver::Project project;
            if (!projectresolver::findById(channels::projectsFile(services), projectId, &project)) return QString();
            return githistory::diffFileBetweenRefs(project.path, ref1, ref2, filePath);
        });
    });

    registry.addAsync(QStringLiteral("git:status"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        runGit(responder, [&services, projectId]() -> QJsonValue {
            projectresolver::Project project;
            if (!projectresolver::findById(channels::projectsFile(services), projectId, &project)) {
                return emptyGroups();
            }
            return gitstatus::getStatus(project.path);
        });
    });

    registry.addAsync(QStringLiteral("git:workspace-file-diff"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString group = channels::stringArg(args, 1);
        const QString filePath = channels::stringArg(args, 2);
        runGit(responder, [&services, projectId, group, filePath]() -> QJsonValue {
            projectresolver::Project project;
            if (!projectresolver::findById(channels::projectsFile(services), projectId, &project)) {
                return QJsonValue(QJsonValue::Null);
            }
            return gitstatus::workspaceFileDiff(project.path, group, filePath, channels::maxEditorFileBytes(services));
        });
    });

    registry.addAsync(QStringLiteral("git:original-content"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonValue pathValue = channels::argAt(args, 0);
        runGit(responder, [&services, pathValue]() -> QJsonValue {
            if (!pathValue.isString() || pathValue.toString().trimmed().isEmpty()) {
                throw ChannelError(QStringLiteral("filePath must be a non-empty string."));
            }
            // Repository containment is not authorization: resolve the path through
            // the same boundary as desktop file reads before reading a blob.
            const QString authorized = channels::authorizePath(services, pathValue.toString(),
                                                               QStringLiteral("gitOriginalContent"),
                                                               pathpolicy::Mode::Read);
            return githistory::getOriginalContent(authorized, channels::maxEditorFileBytes(services));
        });
    });

    registry.addAsync(QStringLiteral("git:worktree-list"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        runGit(responder, [&services, projectId]() -> QJsonValue {
            const QString projectPath = channels::resolveProjectPath(services, projectId);
            const QList<gitworktree::Entry> entries = gitworktree::list(projectPath);
            QJsonArray result;
            for (const gitworktree::Entry &entry : entries) {
                // Keep the sidebar in sync with externally created worktrees.
                if (services.projects) services.projects->add(entry.path, projectId);
                result.append(QJsonObject{
                    {QStringLiteral("path"), entry.path},
                    {QStringLiteral("branch"), entry.branch},
                });
            }
            return result;
        });
    });
}
