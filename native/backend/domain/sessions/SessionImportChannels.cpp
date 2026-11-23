#include "SessionChannelSupport.h"

#include "ClaudeImporter.h"
#include "CodexImporter.h"
#include "OpenCodeImporter.h"
#include "SessionFiles.h"
#include "SessionIdentity.h"
#include "SessionImportCommon.h"

#include "../../process/BackgroundWork.h"

#include <QDir>
#include <QJsonArray>
#include <QJsonObject>

namespace {

/** Importers write into `<home>/.pi/agent/sessions`, not the configured session dir. */
QString piSessionsRoot(const ChannelServices &services)
{
    return QDir(services.hostHome).filePath(QStringLiteral(".pi/agent/sessions"));
}

QString codexRoot(const ChannelServices &services)
{
    return QDir(services.hostHome).filePath(QStringLiteral(".codex/sessions"));
}

QString claudeRoot(const ChannelServices &services)
{
    return QDir(services.hostHome).filePath(QStringLiteral(".claude/projects"));
}

QString openCodeDatabase(const ChannelServices &services)
{
    return QDir(services.hostHome).filePath(QStringLiteral(".local/share/opencode/opencode.db"));
}

QJsonObject codexSummaryJson(const codeximport::Summary &summary)
{
    QJsonObject result{
        {QStringLiteral("id"), summary.id},
        {QStringLiteral("sourcePath"), summary.sourcePath},
        {QStringLiteral("targetPath"), summary.targetPath},
        {QStringLiteral("cwd"), summary.cwd},
        {QStringLiteral("title"), summary.title},
        {QStringLiteral("preview"), summary.preview},
        {QStringLiteral("createdAt"), double(summary.createdAt)},
        {QStringLiteral("updatedAt"), double(summary.updatedAt)},
        {QStringLiteral("messageCount"), summary.messageCount},
        {QStringLiteral("status"), summary.status},
        {QStringLiteral("sourceSize"), double(summary.sourceSize)},
    };
    if (summary.hasImportedSourceMtime) {
        result.insert(QStringLiteral("importedSourceMtime"), double(summary.importedSourceMtime));
    }
    if (!summary.threadSource.isEmpty()) {
        result.insert(QStringLiteral("threadSource"), summary.threadSource);
    }
    if (!summary.parentThreadId.isEmpty()) {
        result.insert(QStringLiteral("parentThreadId"), summary.parentThreadId);
    }
    if (!summary.agentRole.isEmpty()) result.insert(QStringLiteral("agentRole"), summary.agentRole);
    if (!summary.agentNickname.isEmpty()) result.insert(QStringLiteral("agentNickname"), summary.agentNickname);
    return result;
}

QJsonObject importResultJson(const QString &id, const QString &sourcePath, const QString &targetPath,
                             const QString &title, bool success, bool overwritten, int messageCount,
                             const QString &error)
{
    QJsonObject result{
        {QStringLiteral("id"), id},
        {QStringLiteral("sourcePath"), sourcePath},
        {QStringLiteral("success"), success},
    };
    if (success) {
        result.insert(QStringLiteral("targetPath"), targetPath);
        result.insert(QStringLiteral("title"), title);
        result.insert(QStringLiteral("overwritten"), overwritten);
        result.insert(QStringLiteral("messageCount"), messageCount);
    } else {
        result.insert(QStringLiteral("error"), error);
    }
    return result;
}

QJsonObject reportJson(const QJsonArray &results, int imported, int failed)
{
    return QJsonObject{
        {QStringLiteral("results"), results},
        {QStringLiteral("imported"), imported},
        {QStringLiteral("failed"), failed},
    };
}

/** Guard: only files under `root` may be read as an import source. */
void assertInside(const QString &root, const QString &path)
{
    const QString normalizedRoot = sessionimport::normalizePath(root);
    const QString normalizedPath = sessionimport::normalizePath(path);
    if (normalizedPath != normalizedRoot
        && !normalizedPath.startsWith(normalizedRoot + QLatin1Char('/'))) {
        throw ChannelError(QStringLiteral("Import source is outside the expected directory"));
    }
}

QStringList sourcePathsFrom(const QJsonArray &args, int index)
{
    QStringList paths;
    for (const QJsonValue &value : channels::argAt(args, index).toArray()) {
        if (value.isString()) paths.append(value.toString());
    }
    return paths;
}

void registerCodexChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("codex-sessions:scan"), [&services](const QJsonArray &args,
                                                                         ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        sessionchannels::runAsync(responder, [&services, projectId]() -> QJsonValue {
            const QString projectPath = sessionchannels::requireProjectPath(services, projectId);
            const SessionFs &fs = sessionchannels::scannerOf(services).fs();
            const QString root = codexRoot(services);
            const QString normalizedProject = sessionimport::normalizePath(projectPath);
            const maincopy::Translator translate = sessionchannels::translateOf(services);
            const QString piRoot = piSessionsRoot(services);

            QJsonArray summaries;
            for (const QString &file : sessionimport::collectJsonl(fs, root)) {
                // Phase 1: only 64 KiB of the header, so a 1 GB rollout belonging to
                // another project costs nothing.
                codeximport::Session header;
                if (!codeximport::readMetaOnly(fs, file, &header)) continue;
                if (sessionimport::normalizePath(header.meta.value(QStringLiteral("cwd")).toString())
                    != normalizedProject) {
                    continue;
                }
                codeximport::Session session;
                if (!codeximport::readSession(fs, file, &session)) continue;
                const sessionimport::Converted converted =
                    codeximport::convert(projectPath, session, translate);
                const QString targetPath = codeximport::targetPathFor(piRoot, projectPath, session);
                const sessionimport::ImportMeta meta =
                    sessionimport::readImportMeta(fs, targetPath, QStringLiteral("codex"));
                codeximport::Summary summary;
                summary.id = header.meta.value(QStringLiteral("id")).toString();
                summary.sourcePath = file;
                summary.targetPath = targetPath;
                summary.cwd = session.meta.value(QStringLiteral("cwd")).toString();
                summary.title = converted.title;
                summary.preview = converted.preview;
                summary.messageCount = converted.messageCount;
                summary.status =
                    sessionimport::statusOf(meta, session.sourceMtime, session.sourceSize);
                summary.sourceSize = session.sourceSize;
                summary.hasImportedSourceMtime = meta.found;
                summary.importedSourceMtime = meta.sourceMtime;
                const codeximport::ThreadInfo threadInfo = codeximport::threadInfoOf(session.meta);
                summary.threadSource = threadInfo.threadSource;
                summary.parentThreadId = threadInfo.parentThreadId;
                summary.agentRole = threadInfo.agentRole;
                summary.agentNickname = threadInfo.agentNickname;
                qint64 created = 0;
                const QDateTime parsed = QDateTime::fromString(
                    session.meta.value(QStringLiteral("timestamp")).toString(), Qt::ISODateWithMs);
                created = parsed.isValid() ? parsed.toMSecsSinceEpoch() : session.sourceMtime;
                summary.createdAt = created;
                summary.updatedAt = created;
                summaries.append(codexSummaryJson(summary));
            }
            return summaries;
        });
    });

    registry.addAsync(QStringLiteral("codex-sessions:import"), [&services](const QJsonArray &args,
                                                                           ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QStringList sourcePaths = sourcePathsFrom(args, 1);
        sessionchannels::runAsync(responder, [&services, projectId, sourcePaths]() -> QJsonValue {
            const QString projectPath = sessionchannels::requireProjectPath(services, projectId);
            const SessionFs &fs = sessionchannels::scannerOf(services).fs();
            const QString root = codexRoot(services);
            const maincopy::Translator translate = sessionchannels::translateOf(services);
            const QString piRoot = piSessionsRoot(services);
            QJsonArray results;
            int imported = 0;
            int failed = 0;
            for (const QString &sourcePath : sourcePaths) {
                try {
                    assertInside(root, sourcePath);
                    codeximport::Session session;
                    if (!codeximport::readSession(fs, sourcePath, &session)) {
                        throw ChannelError(QStringLiteral("Missing Codex session metadata"));
                    }
                    const QString targetPath = codeximport::targetPathFor(piRoot, projectPath, session);
                    const sessionimport::ImportMeta existing =
                        sessionimport::readImportMeta(fs, targetPath, QStringLiteral("codex"));
                    const sessionimport::Converted converted =
                        codeximport::convert(projectPath, session, translate);
                    QString error;
                    if (!sessionimport::writeImported(fs, targetPath, converted.raw, &error)) {
                        throw ChannelError(error);
                    }
                    results.append(importResultJson(
                        session.meta.value(QStringLiteral("id")).toString(), sourcePath, targetPath,
                        converted.title, true, existing.found, converted.messageCount, QString()));
                    ++imported;
                } catch (const std::exception &failure) {
                    results.append(importResultJson(sourcePath, sourcePath, QString(), QString(), false,
                                                    false, 0, QString::fromUtf8(failure.what())));
                    ++failed;
                }
            }
            return reportJson(results, imported, failed);
        });
    });
}

void registerClaudeChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("claude-sessions:scan"), [&services](const QJsonArray &args,
                                                                          ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        sessionchannels::runAsync(responder, [&services, projectId]() -> QJsonValue {
            const QString projectPath = sessionchannels::requireProjectPath(services, projectId);
            const SessionFs &fs = sessionchannels::scannerOf(services).fs();
            const maincopy::Translator translate = sessionchannels::translateOf(services);
            const QString piRoot = piSessionsRoot(services);
            const QString directory = claudeimport::projectDir(claudeRoot(services), projectPath);
            QJsonArray summaries;
            for (const QString &file : sessionimport::collectJsonl(fs, directory)) {
                claudeimport::Session session;
                if (!claudeimport::readSession(fs, file, &session)) continue;
                const sessionimport::Converted converted =
                    claudeimport::convert(projectPath, session, translate);
                const QString targetPath = claudeimport::targetPathFor(piRoot, projectPath, session);
                const sessionimport::ImportMeta meta =
                    sessionimport::readImportMeta(fs, targetPath, QStringLiteral("claude"));
                QJsonObject summary{
                    {QStringLiteral("id"), session.sessionId},
                    {QStringLiteral("sourcePath"), file},
                    {QStringLiteral("targetPath"), targetPath},
                    {QStringLiteral("cwd"), session.cwd},
                    {QStringLiteral("title"), converted.title},
                    {QStringLiteral("preview"), converted.preview},
                    {QStringLiteral("createdAt"), double(session.firstTimestamp)},
                    {QStringLiteral("updatedAt"), double(session.lastTimestamp)},
                    {QStringLiteral("messageCount"), converted.messageCount},
                    {QStringLiteral("status"),
                     sessionimport::statusOf(meta, session.sourceMtime, session.sourceSize)},
                    {QStringLiteral("sourceSize"), double(session.sourceSize)},
                };
                if (meta.found) summary.insert(QStringLiteral("importedSourceMtime"), double(meta.sourceMtime));
                summaries.append(summary);
            }
            return summaries;
        });
    });

    registry.addAsync(QStringLiteral("claude-sessions:import"), [&services](const QJsonArray &args,
                                                                            ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QStringList sourcePaths = sourcePathsFrom(args, 1);
        sessionchannels::runAsync(responder, [&services, projectId, sourcePaths]() -> QJsonValue {
            const QString projectPath = sessionchannels::requireProjectPath(services, projectId);
            const SessionFs &fs = sessionchannels::scannerOf(services).fs();
            const QString root = claudeRoot(services);
            const maincopy::Translator translate = sessionchannels::translateOf(services);
            const QString piRoot = piSessionsRoot(services);
            QJsonArray results;
            int imported = 0;
            int failed = 0;
            for (const QString &sourcePath : sourcePaths) {
                try {
                    assertInside(root, sourcePath);
                    claudeimport::Session session;
                    if (!claudeimport::readSession(fs, sourcePath, &session)) {
                        throw ChannelError(QStringLiteral("Missing Claude session metadata"));
                    }
                    const QString targetPath = claudeimport::targetPathFor(piRoot, projectPath, session);
                    const sessionimport::ImportMeta existing =
                        sessionimport::readImportMeta(fs, targetPath, QStringLiteral("claude"));
                    const sessionimport::Converted converted =
                        claudeimport::convert(projectPath, session, translate);
                    QString error;
                    if (!sessionimport::writeImported(fs, targetPath, converted.raw, &error)) {
                        throw ChannelError(error);
                    }
                    results.append(importResultJson(session.sessionId, sourcePath, targetPath,
                                                    converted.title, true, existing.found,
                                                    converted.messageCount, QString()));
                    ++imported;
                } catch (const std::exception &failure) {
                    results.append(importResultJson(sourcePath, sourcePath, QString(), QString(), false,
                                                    false, 0, QString::fromUtf8(failure.what())));
                    ++failed;
                }
            }
            return reportJson(results, imported, failed);
        });
    });
}

void registerOpenCodeChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("opencode-sessions:scan"), [&services](const QJsonArray &args,
                                                                            ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        sessionchannels::runAsync(responder, [&services, projectId]() -> QJsonValue {
            const QString projectPath = sessionchannels::requireProjectPath(services, projectId);
            const SessionFs &fs = sessionchannels::scannerOf(services).fs();
            const QString database = openCodeDatabase(services);
            QString error;
            // A missing database is "no OpenCode history", not an error: the renderer
            // shows an empty list for users who never installed OpenCode.
            if (!opencodeimport::available(database, &error)) return QJsonArray{};
            const QVector<opencodeimport::Session> sessions =
                opencodeimport::readSessions(database, projectPath, &error);
            if (!error.isEmpty()) throw ChannelError(error);
            const maincopy::Translator translate = sessionchannels::translateOf(services);
            const QString piRoot = piSessionsRoot(services);
            QJsonArray summaries;
            for (const opencodeimport::Session &session : sessions) {
                const sessionimport::Converted converted =
                    opencodeimport::convert(projectPath, session, translate);
                const QString targetPath = opencodeimport::targetPathFor(piRoot, projectPath, session);
                const sessionimport::ImportMeta meta =
                    sessionimport::readImportMeta(fs, targetPath, QStringLiteral("opencode"));
                const QString cwd = session.meta.value(QStringLiteral("directory")).toString();
                QJsonObject summary{
                    {QStringLiteral("id"), session.meta.value(QStringLiteral("id")).toString()},
                    {QStringLiteral("sourcePath"), session.sourcePath},
                    {QStringLiteral("targetPath"), targetPath},
                    {QStringLiteral("cwd"), cwd.isEmpty() ? projectPath : cwd},
                    {QStringLiteral("title"), converted.title},
                    {QStringLiteral("preview"), converted.preview},
                    {QStringLiteral("createdAt"),
                     session.meta.value(QStringLiteral("time_created")).toDouble()},
                    {QStringLiteral("updatedAt"),
                     session.meta.value(QStringLiteral("time_updated")).toDouble()},
                    {QStringLiteral("messageCount"), converted.messageCount},
                    {QStringLiteral("status"),
                     sessionimport::statusOf(meta, session.sourceMtime, session.sourceSize)},
                    {QStringLiteral("sourceSize"), double(session.sourceSize)},
                };
                if (meta.found) summary.insert(QStringLiteral("importedSourceMtime"), double(meta.sourceMtime));
                summaries.append(summary);
            }
            return summaries;
        });
    });

    registry.addAsync(QStringLiteral("opencode-sessions:import"), [&services](const QJsonArray &args,
                                                                             ChannelResponder responder) {
        const QString projectId = channels::stringArg(args, 0);
        const QStringList sourcePaths = sourcePathsFrom(args, 1);
        sessionchannels::runAsync(responder, [&services, projectId, sourcePaths]() -> QJsonValue {
            const QString projectPath = sessionchannels::requireProjectPath(services, projectId);
            const SessionFs &fs = sessionchannels::scannerOf(services).fs();
            const QString database = openCodeDatabase(services);
            const maincopy::Translator translate = sessionchannels::translateOf(services);
            const QString piRoot = piSessionsRoot(services);
            QString readError;
            QVector<opencodeimport::Session> sessions;
            if (opencodeimport::available(database, &readError)) {
                sessions = opencodeimport::readSessions(database, projectPath, &readError);
            }
            QHash<QString, int> bySourcePath;
            for (int index = 0; index < sessions.size(); ++index) {
                bySourcePath.insert(sessions.at(index).sourcePath, index);
            }
            QJsonArray results;
            int imported = 0;
            int failed = 0;
            for (const QString &sourcePath : sourcePaths) {
                try {
                    const auto found = bySourcePath.constFind(sourcePath);
                    if (found == bySourcePath.constEnd()) {
                        throw ChannelError(QStringLiteral("OpenCode session not found in database"));
                    }
                    const opencodeimport::Session &session = sessions.at(found.value());
                    const QString targetPath = opencodeimport::targetPathFor(piRoot, projectPath, session);
                    const sessionimport::ImportMeta existing =
                        sessionimport::readImportMeta(fs, targetPath, QStringLiteral("opencode"));
                    const sessionimport::Converted converted =
                        opencodeimport::convert(projectPath, session, translate);
                    QString error;
                    if (!sessionimport::writeImported(fs, targetPath, converted.raw, &error)) {
                        throw ChannelError(error);
                    }
                    results.append(importResultJson(
                        session.meta.value(QStringLiteral("id")).toString(), sourcePath, targetPath,
                        converted.title, true, existing.found, converted.messageCount, QString()));
                    ++imported;
                } catch (const std::exception &failure) {
                    results.append(importResultJson(sourcePath, sourcePath, QString(), QString(), false,
                                                    false, 0, QString::fromUtf8(failure.what())));
                    ++failed;
                }
            }
            return reportJson(results, imported, failed);
        });
    });
}

} // namespace

void registerSessionImportChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registerCodexChannels(registry, services);
    registerClaudeChannels(registry, services);
    registerOpenCodeChannels(registry, services);
}
