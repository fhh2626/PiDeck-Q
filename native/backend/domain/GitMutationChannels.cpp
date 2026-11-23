#include "GitChannelParts.h"

#include "BackgroundWork.h"
#include "GitHistory.h"
#include "GitMutations.h"
#include "GitService.h"
#include "GitWorktree.h"
#include "MainCopy.h"
#include "ProjectStore.h"
#include "ProjectResolver.h"
#include "QuickGenerator.h"
#include "TrashHelper.h"

#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QRegularExpression>

namespace {

using background::Outcome;

void settle(ChannelResponder responder, const Outcome &outcome)
{
    if (outcome.ok) responder.resolve(outcome.value);
    else responder.reject(outcome.error);
}

QString language(const ChannelServices &services)
{
    return channels::settingValue(services, QStringLiteral("language")).toString();
}

QString localized(const ChannelServices &services, const QString &key)
{
    return maincopy::text(language(services), key);
}

/**
 * Mutations resolve the project eagerly: a missing project must fail the call, not
 * silently succeed, because the renderer shows the error inline.
 */
QString requireProject(const ChannelServices &services, const QString &projectId)
{
    return channels::resolveProjectPath(services, projectId);
}

QStringList requirePaths(const QJsonValue &value)
{
    const QJsonArray array = value.toArray();
    if (!value.isArray() || array.isEmpty()) throw ChannelError(QStringLiteral("Invalid paths"));
    QStringList paths;
    for (const QJsonValue &item : array) {
        if (!item.isString() || item.toString().isEmpty()) throw ChannelError(QStringLiteral("Invalid paths"));
        paths.append(item.toString());
    }
    return paths;
}

/** Run a void mutation off the event loop; the channel resolves with null. */
void runVoid(ChannelResponder responder, std::function<void()> task)
{
    background::runBlocking(
        [task = std::move(task)]() -> QJsonValue {
            task();
            return QJsonValue(QJsonValue::Null);
        },
        [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
}

} // namespace

void registerGitMutationChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("git:checkout"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString branch = channels::stringArg(args, 1);
        background::runBlocking(
            [&services, projectId, branch]() -> QJsonValue {
                return gitservice::checkout(requireProject(services, projectId), branch);
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("git:create-branch"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString branchName = channels::stringArg(args, 1);
        background::runBlocking(
            [&services, projectId, branchName]() -> QJsonValue {
                return gitservice::createBranch(requireProject(services, projectId), branchName);
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("git:ahead-behind"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        background::runBlocking(
            [&services, projectId]() -> QJsonValue {
                return gitservice::getAheadBehind(requireProject(services, projectId));
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("git:stage"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QJsonValue pathsValue = channels::argAt(args, 1);
        background::runBlocking(
            [&services, projectId, pathsValue]() -> QJsonValue {
                const QStringList paths = requirePaths(pathsValue);
                gitmutations::stageFiles(requireProject(services, projectId), paths);
                return QJsonValue(QJsonValue::Null);
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("git:unstage"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QJsonValue pathsValue = channels::argAt(args, 1);
        background::runBlocking(
            [&services, projectId, pathsValue]() -> QJsonValue {
                const QStringList paths = requirePaths(pathsValue);
                gitmutations::unstageFiles(requireProject(services, projectId), paths);
                return QJsonValue(QJsonValue::Null);
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("git:discard"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString group = channels::stringArg(args, 1);
        const QString filePath = channels::stringArg(args, 2);
        background::runBlocking(
            [&services, projectId, group, filePath]() -> QJsonValue {
                const gitmutations::TrashPlan plan =
                    gitmutations::discardFile(requireProject(services, projectId), group, filePath);
                if (!plan.needed) return QJsonValue(QJsonValue::Null);
                if (plan.unlinkInstead) {
                    // A symlink is unlinked directly: only the link disappears, so no
                    // user content is at risk and the recycle bin is unnecessary.
                    gitmutations::unlinkPath(plan.path);
                    return QJsonValue(QJsonValue::Null);
                }
                return QJsonObject{
                    {QStringLiteral("trash"), plan.path},
                };
            },
            [&services, responder](const Outcome &outcome) mutable {
        if (!outcome.ok) return responder.reject(outcome.error);
        const QString trashPath = outcome.value.toObject().value(QStringLiteral("trash")).toString();
        if (trashPath.isEmpty()) return responder.resolve(QJsonValue(QJsonValue::Null));
        trashhelper::trashAll(services.host, QStringList{trashPath}, [responder](bool ok, const QString &error) mutable {
            if (!ok) return responder.reject(error);
            responder.resolve(QJsonValue(QJsonValue::Null));
        });
    });
    });

    registry.addAsync(QStringLiteral("git:delete-files"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QJsonValue pathsValue = channels::argAt(args, 1);
        background::runBlocking(
            [&services, projectId, pathsValue]() -> QJsonValue {
                const QStringList paths = requirePaths(pathsValue);
                const QStringList targets = gitmutations::deleteFiles(requireProject(services, projectId), paths);
                QJsonArray array;
                for (const QString &target : targets) array.append(target);
                return array;
            },
            [&services, responder](const Outcome &outcome) mutable {
        if (!outcome.ok) return responder.reject(outcome.error);
        QStringList targets;
        for (const QJsonValue &value : outcome.value.toArray()) targets.append(value.toString());
        trashhelper::trashAll(services.host, targets, [responder](bool ok, const QString &error) mutable {
            if (!ok) return responder.reject(error);
            responder.resolve(QJsonValue(QJsonValue::Null));
        });
    });
    });

    registry.addAsync(QStringLiteral("git:commit"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString message = channels::stringArg(args, 1);
        runVoid(responder, [&services, projectId, message] {
            gitmutations::commit(requireProject(services, projectId), message);
        });
    });

    registry.addAsync(QStringLiteral("git:cherry-pick"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString hash = channels::stringArg(args, 1);
        runVoid(responder, [&services, projectId, hash] {
            gitmutations::cherryPick(requireProject(services, projectId), hash);
        });
    });

    registry.addAsync(QStringLiteral("git:revert"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString hash = channels::stringArg(args, 1);
        runVoid(responder, [&services, projectId, hash] {
            gitmutations::revertCommit(requireProject(services, projectId), hash);
        });
    });

    registry.addAsync(QStringLiteral("git:reset"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString hash = channels::stringArg(args, 1);
        const QString mode = channels::stringArg(args, 2);
        runVoid(responder, [&services, projectId, hash, mode] {
            gitmutations::resetToCommit(requireProject(services, projectId), hash, mode);
        });
    });

    registry.addAsync(QStringLiteral("git:drop-commit"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString hash = channels::stringArg(args, 1);
        runVoid(responder, [&services, projectId, hash] {
            gitmutations::dropCommit(requireProject(services, projectId), hash);
        });
    });

    registry.addAsync(QStringLiteral("git:push"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        runVoid(responder, [&services, projectId] { gitmutations::push(requireProject(services, projectId)); });
    });

    registry.addAsync(QStringLiteral("git:pull"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        runVoid(responder, [&services, projectId] { gitmutations::pull(requireProject(services, projectId)); });
    });

    registry.addAsync(QStringLiteral("git:fetch"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        runVoid(responder, [&services, projectId] { gitmutations::fetch(requireProject(services, projectId)); });
    });

    registry.addAsync(QStringLiteral("git:init"), [&services](const QJsonArray &args, ChannelResponder responder) {
        const QJsonValue projectValue = channels::argAt(args, 0);
        runVoid(responder, [&services, projectValue] {
            if (!projectValue.isString() || projectValue.toString().trimmed().isEmpty()) {
                throw ChannelError(QStringLiteral("projectId must be a non-empty string."));
            }
            gitmutations::init(requireProject(services, projectValue.toString()));
        });
    });

    // ── Worktrees ─────────────────────────────────────────────────────────────
    registry.addAsync(QStringLiteral("git:worktree-create"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString branchName = channels::stringArg(args, 1);
        background::runBlocking(
            [&services, projectId, branchName]() -> QJsonValue {
                const QString projectPath = requireProject(services, projectId);
                const QJsonObject info = gitworktree::create(projectPath, branchName);
                if (services.projects) {
                    services.projects->add(info.value(QStringLiteral("path")).toString(), projectId);
                }
                return info;
            },
            [responder](const Outcome &outcome) mutable { settle(responder, outcome); });
    });

    registry.addAsync(QStringLiteral("git:worktree-remove"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QString worktreePath = channels::stringArg(args, 1);
        background::runBlocking(
            [&services, projectId, worktreePath]() -> QJsonValue {
                const QString projectPath = requireProject(services, projectId);
                const bool removed = gitworktree::remove(worktreePath, projectPath);
                bool stillInGit = false;
                for (const gitworktree::Entry &entry : gitworktree::list(projectPath)) {
                    if (QFileInfo(entry.path).absoluteFilePath() == QFileInfo(worktreePath).absoluteFilePath()) {
                        stillInGit = true;
                        break;
                    }
                }
                // A directory git no longer tracks but that still exists on disk has to
                // be moved to the recycle bin; a surviving git entry means the removal
                // did not happen at all.
                const bool directoryExists = QFileInfo::exists(worktreePath);
                return QJsonObject{
                    {QStringLiteral("removed"), removed},
                    {QStringLiteral("stillInGit"), stillInGit},
                    {QStringLiteral("directoryExists"), directoryExists},
                };
            },
            [&services, projectId, worktreePath, responder](const Outcome &outcome) mutable {
        if (!outcome.ok) return responder.reject(outcome.error);
        const QJsonObject result = outcome.value.toObject();
        const bool removed = result.value(QStringLiteral("removed")).toBool();
        const bool stillInGit = result.value(QStringLiteral("stillInGit")).toBool();
        const bool directoryExists = result.value(QStringLiteral("directoryExists")).toBool();
        if (!removed && stillInGit) return responder.resolve(false);
        // Clean up the PiDeck project record as well, otherwise a restart restores a
        // worktree project that can never be removed.
        const QJsonObject child = services.projects ? services.projects->findByPath(worktreePath)
                                                    : QJsonObject{};
        if (!child.isEmpty()) services.projects->remove(child.value(QStringLiteral("id")).toString());
        if (!directoryExists) return responder.resolve(true);
        trashhelper::trashAll(services.host, QStringList{worktreePath},
                              [responder](bool ok, const QString &error) mutable {
            if (!ok) return responder.reject(error);
            responder.resolve(true);
        });
    });
    });

    // ── AI commit message ─────────────────────────────────────────────────────
    registry.addAsync(QStringLiteral("git:generate-commit-message"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        background::runBlocking(
            [&services, projectId]() -> QJsonValue {
                projectresolver::Project project;
                if (!projectresolver::findById(channels::projectsFile(services), projectId, &project)) {
                    return QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("message"), QString()}};
                }
                const QString diff = githistory::getStagedDiff(project.path);
                if (diff.trimmed().isEmpty()) {
                    return QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("message"), QString()}};
                }
                const QString provider =
                    channels::settingValue(services, QStringLiteral("gitCommitMessageProvider")).toString().trimmed();
                const QString modelId =
                    channels::settingValue(services, QStringLiteral("gitCommitMessageModel")).toString().trimmed();
                if (provider.isEmpty() || modelId.isEmpty()) {
                    // Structured code so the renderer can offer a "go to settings"
                    // action instead of printing a sentence.
                    return QJsonObject{
                        {QStringLiteral("ok"), false},
                        {QStringLiteral("code"), QStringLiteral("GIT_COMMIT_MODEL_REQUIRED")},
                        {QStringLiteral("message"), localized(services, QStringLiteral("git.commitMessageModelRequired"))},
                    };
                }
                const QString configured =
                    channels::settingValue(services, QStringLiteral("gitCommitMessagePrompt")).toString();
                const QString promptTemplate = configured.isEmpty()
                    ? maincopy::defaultGitCommitMessagePrompt(language(services))
                    : configured;
                QString prompt = promptTemplate;
                prompt.replace(QStringLiteral("{diff}"), diff.left(8000));
                return QJsonObject{
                    {QStringLiteral("ready"), true},
                    {QStringLiteral("prompt"), prompt},
                    {QStringLiteral("provider"), provider},
                    {QStringLiteral("modelId"), modelId},
                    {QStringLiteral("projectPath"), project.path},
                };
            },
            [&services, responder](const Outcome &outcome) mutable {
        if (!outcome.ok) return responder.reject(outcome.error);
        const QJsonObject prepared = outcome.value.toObject();
        if (!prepared.value(QStringLiteral("ready")).toBool()) return responder.resolve(prepared);
        if (!services.quickGenerator) {
            return responder.resolve(QJsonObject{
                {QStringLiteral("ok"), false},
                {QStringLiteral("code"), QStringLiteral("GIT_COMMIT_GENERATE_FAILED")},
                {QStringLiteral("message"), QStringLiteral("Quick generator is unavailable")},
            });
        }
        services.quickGenerator->generate(
            prepared.value(QStringLiteral("projectPath")).toString(),
            prepared.value(QStringLiteral("prompt")).toString(),
            prepared.value(QStringLiteral("provider")).toString(),
            prepared.value(QStringLiteral("modelId")).toString(),
            [&services, responder](bool ok, const QString &message, const QString &error) mutable {
                if (ok) {
                    return responder.resolve(QJsonObject{{QStringLiteral("ok"), true},
                                                         {QStringLiteral("message"), message.trimmed()}});
                }
                // pi's busy rejection is technical English; map it to a localized
                // message so the UI does not show a raw error.
                static const QRegularExpression busy(QStringLiteral("Agent is already processing"),
                                                     QRegularExpression::CaseInsensitiveOption);
                static const QRegularExpression timedOut(QStringLiteral("timed out"),
                                                         QRegularExpression::CaseInsensitiveOption);
                if (busy.match(error).hasMatch()) {
                    return responder.resolve(QJsonObject{
                        {QStringLiteral("ok"), false},
                        {QStringLiteral("code"), QStringLiteral("GIT_COMMIT_BUSY")},
                        {QStringLiteral("message"), localized(services, QStringLiteral("git.commitMessageBusy"))},
                    });
                }
                if (timedOut.match(error).hasMatch()) {
                    return responder.resolve(QJsonObject{
                        {QStringLiteral("ok"), false},
                        {QStringLiteral("code"), QStringLiteral("GIT_COMMIT_TIMEOUT")},
                        {QStringLiteral("message"), localized(services, QStringLiteral("git.commitMessageTimeout"))},
                    });
                }
                responder.resolve(QJsonObject{
                    {QStringLiteral("ok"), false},
                    {QStringLiteral("code"), QStringLiteral("GIT_COMMIT_GENERATE_FAILED")},
                    {QStringLiteral("message"), error},
                });
            });
    });
    });
}
