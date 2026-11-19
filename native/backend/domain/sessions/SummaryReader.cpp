#include "SummaryReader.h"

#include "MessageContent.h"
#include "PiTaskMessage.h"
#include "ScanRoots.h"
#include "SessionFiles.h"
#include "SessionIdentity.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>

#include <cmath>

namespace summaryreader {
namespace {

/** -2^63 and 2^63 are both exactly representable as doubles; qint64 spans [-2^63, 2^63). */
constexpr double kInt64Min = -9223372036854775808.0;
constexpr double kInt64MaxExclusive = 9223372036854775808.0;

constexpr int kPreviewLimit = 160;
constexpr int kTitleLimit = 32;

QString optionalString(const QJsonValue &value)
{
    if (!value.isString()) return QString();
    const QString text = value.toString().trimmed();
    return text;
}

QString firstString(const QJsonObject &entry, const QStringList &keys)
{
    for (const QString &key : keys) {
        const QString value = optionalString(entry.value(key));
        if (!value.isEmpty()) return value;
    }
    return QString();
}

QString nestedString(const QJsonObject &entry, const QString &container, const QStringList &keys)
{
    const QJsonValue value = entry.value(container);
    if (!value.isObject()) return QString();
    return firstString(value.toObject(), keys);
}

QString cleanTitle(const QString &value)
{
    if (value.isEmpty()) return QString();
    static const QRegularExpression whitespace(QStringLiteral("\\s+"));
    QString text = value;
    text.replace(whitespace, QStringLiteral(" "));
    text = text.trimmed();
    if (text.isEmpty()) return QString();
    static const QRegularExpression untitled(QStringLiteral("^untitled$"), QRegularExpression::CaseInsensitiveOption);
    if (untitled.match(text).hasMatch()) return QString();
    return text.size() > kTitleLimit ? text.left(kTitleLimit) + QStringLiteral("…") : text;
}

QString extractText(const QJsonValue &content)
{
    if (content.isString()) return content.toString();
    if (!content.isArray()) return QString();
    QStringList parts;
    for (const QJsonValue &item : content.toArray()) {
        if (item.isString()) {
            parts.append(item.toString());
            continue;
        }
        if (!item.isObject()) continue;
        const QJsonObject block = item.toObject();
        const QString text = block.value(QStringLiteral("text")).toString();
        if (!text.isEmpty()) {
            parts.append(text);
            continue;
        }
        const QString thinking = block.value(QStringLiteral("thinking")).toString();
        if (!thinking.isEmpty()) parts.append(thinking);
    }
    return parts.join(QLatin1Char(' '));
}

bool isPiSubagentLayoutPath(const SessionFs &fs, const QString &filePath)
{
    if (fs.basename(filePath) != QLatin1String("session.jsonl")) return false;
    const QString runDir = fs.basename(fs.dirname(filePath));
    static const QRegularExpression pattern(QStringLiteral("^run-\\d+$"), QRegularExpression::CaseInsensitiveOption);
    return pattern.match(runDir).hasMatch();
}

QString findSessionsRootForFile(const SessionFs &fs, const QStringList &scanRoots, const QString &filePath,
                                const QString &defaultRoot)
{
    const QString normalizedFile = sessionidentity::normalizeScanPath(filePath);
    QString best = defaultRoot;
    int bestLength = -1;
    const QStringList roots = scanRoots.isEmpty() ? QStringList{defaultRoot} : scanRoots;
    for (const QString &root : roots) {
        const QString normalizedRoot = sessionidentity::normalizeScanPath(root);
        if (normalizedFile != normalizedRoot && !normalizedFile.startsWith(normalizedRoot + QLatin1Char('/'))) {
            continue;
        }
        if (normalizedRoot.size() > bestLength) {
            best = root;
            bestLength = normalizedRoot.size();
        }
    }
    return best;
}

QString inferParentSessionFromPath(const SessionFs &fs, const QStringList &scanRoots, const QString &filePath,
                                   const QString &defaultRoot)
{
    if (!filePath.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive)) return QString();
    const QString normalizedRoot =
        sessionidentity::normalizeScanPath(findSessionsRootForFile(fs, scanRoots, filePath, defaultRoot));
    QString currentDir = fs.dirname(filePath);
    for (int depth = 0; depth < 10; ++depth) {
        const QString normalizedDir = sessionidentity::normalizeScanPath(currentDir);
        if (normalizedDir == normalizedRoot
            || !normalizedDir.startsWith(normalizedRoot + QLatin1Char('/'))) {
            break;
        }
        const QString dirName = fs.basename(currentDir);
        if (dirName.isEmpty()) break;
        const QString parentDir = fs.dirname(currentDir);
        const QString candidate = fs.join(parentDir, dirName + QStringLiteral(".jsonl"));
        if (fs.isFile(candidate)) {
            QString head;
            QString error;
            if (fs.readHead(candidate, 4096, &head, &error) && hasSessionHeader(head)) return candidate;
        }
        currentDir = parentDir;
    }
    return QString();
}

struct CodexThreadInfo {
    QString threadSource;
    QString parentThreadId;
    QString agentRole;
    QString agentNickname;
};

CodexThreadInfo codexThreadInfo(const QJsonObject &meta)
{
    CodexThreadInfo info;
    const QJsonObject source = meta.value(QStringLiteral("source")).toObject();
    const QJsonObject subagent = source.value(QStringLiteral("subagent")).toObject();
    const QJsonObject spawn = subagent.value(QStringLiteral("thread_spawn")).toObject();
    const QString threadSource = meta.value(QStringLiteral("thread_source")).toString();
    const bool hasParent = !optionalString(meta.value(QStringLiteral("parent_thread_id"))).isEmpty();
    // An explicit "user" wins even when parent_thread_id is present, otherwise old
    // records without thread_source are detected through the parent id.
    const bool isSubagent = threadSource == QLatin1String("subagent")
        || (threadSource != QLatin1String("user") && hasParent) || !subagent.isEmpty();
    if (!isSubagent) {
        info.threadSource = QStringLiteral("user");
        return info;
    }
    info.threadSource = QStringLiteral("subagent");
    info.parentThreadId = optionalString(meta.value(QStringLiteral("parent_thread_id")));
    if (info.parentThreadId.isEmpty()) info.parentThreadId = optionalString(spawn.value(QStringLiteral("parent_thread_id")));
    if (info.parentThreadId.isEmpty()) info.parentThreadId = optionalString(meta.value(QStringLiteral("session_id")));
    info.agentRole = optionalString(meta.value(QStringLiteral("agent_role")));
    if (info.agentRole.isEmpty()) info.agentRole = optionalString(spawn.value(QStringLiteral("agent_role")));
    info.agentNickname = optionalString(meta.value(QStringLiteral("agent_nickname")));
    if (info.agentNickname.isEmpty()) info.agentNickname = optionalString(spawn.value(QStringLiteral("agent_nickname")));
    return info;
}

CodexThreadInfo readCodexThreadInfo(const Context &context, const QString &sourcePath)
{
    const QString root = sessionidentity::normalizeScanPath(context.codexRoot);
    const QString target = sessionidentity::normalizeScanPath(sourcePath);
    if (root.isEmpty() || (target != root && !target.startsWith(root + QLatin1Char('/')))) return {};
    QString raw;
    QString error;
    if (!sessionfiles::readText(sourcePath, &raw, &error)) return {};
    const QStringList lines = raw.split(QLatin1Char('\n'));
    for (int index = 0; index < lines.size() && index < 16; ++index) {
        const QString line = lines.at(index).trimmed();
        if (line.isEmpty()) continue;
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        if (!document.isObject()) continue;
        const QJsonObject entry = document.object();
        if (entry.value(QStringLiteral("type")).toString() != QLatin1String("session_meta")) continue;
        const QJsonObject payload = entry.value(QStringLiteral("payload")).toObject();
        if (payload.isEmpty()) continue;
        return codexThreadInfo(payload);
    }
    return {};
}

} // namespace

bool hasSessionHeader(const QString &head)
{
    int checked = 0;
    for (const QString &line : head.split(QLatin1Char('\n'))) {
        if (line.trimmed().isEmpty()) continue;
        if (++checked > 12) break;
        const QJsonDocument document = QJsonDocument::fromJson(line.trimmed().toUtf8());
        if (!document.isObject()) continue;
        if (document.object().value(QStringLiteral("type")).isString()) return true;
    }
    return false;
}

QString inferProjectPathFromFile(const QString &filePath)
{
    QString normalized = filePath;
    normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
    const int marker = normalized.toLower().indexOf(QStringLiteral("/.pi/agent/sessions/"));
    if (marker != -1) {
        const QString rest = normalized.mid(marker + 21);
        return sessionidentity::decodeSessionDir(rest.section(QLatin1Char('/'), 0, 0));
    }
    const int custom = normalized.toLower().lastIndexOf(QStringLiteral("/.pi/sessions/"));
    if (custom != -1) return QDir::fromNativeSeparators(normalized.left(custom));
    return QString();
}

Result read(const QString &filePath, const QString &raw, qint64 mtimeMs, const Context &context)
{
    Result result;
    const QStringList lines = raw.split(QLatin1Char('\n'));
    QString latestSessionInfoName;
    QString forkParentSession;
    bool hasSubagentChildMarker = false;
    QString name;
    QString projectPath;
    QString preview = context.translate(QStringLiteral("session.emptyPreview"), QJsonObject{});
    const QString emptyPreview = preview;
    QString firstUserText;
    QString firstAssistantText;
    int messageCount = 0;
    QString source = QStringLiteral("pi");
    QString codexSessionId;
    QString codexThreadSource;
    QString codexParentThreadId;
    QString codexAgentRole;
    QString codexAgentNickname;
    QString codexSourcePath;
    QString modelProvider;
    QString modelId;
    QString thinkingLevel;
    bool hasThinkingLevel = false;
    bool hasLastAssistantModel = false;
    QString lastAssistantProvider;
    QString lastAssistantModel;
    int validEntries = 0;

    for (const QString &rawLine : lines) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty()) continue;
        QJsonParseError parseError{};
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8(), &parseError);
        if (parseError.error != QJsonParseError::NoError || !document.isObject()) continue;
        const QJsonObject entry = document.object();
        ++validEntries;
        const QString type = entry.value(QStringLiteral("type")).toString();
        if (type == QLatin1String("session_info")) {
            // Forked sessions can carry an older copied name; only the latest wins.
            QString candidate = optionalString(entry.value(QStringLiteral("name")));
            if (candidate.isEmpty()) {
                candidate = optionalString(entry.value(QStringLiteral("data")).toObject()
                                               .value(QStringLiteral("name")));
            }
            if (!candidate.isEmpty()) latestSessionInfoName = candidate;
        }
        if (type == QLatin1String("session") && forkParentSession.isEmpty()) {
            forkParentSession = optionalString(entry.value(QStringLiteral("parentSession")));
        }
        const QString customType = entry.value(QStringLiteral("customType")).toString();
        if (type == QLatin1String("custom") && customType.endsWith(QLatin1String(".child-session"))) {
            hasSubagentChildMarker = true;
        }
        if (source == QLatin1String("pi")) {
            if (type == QLatin1String("codex_import")) {
                source = QStringLiteral("codex");
                codexSessionId = optionalString(entry.value(QStringLiteral("codexSessionId")));
                codexSourcePath = optionalString(entry.value(QStringLiteral("sourcePath")));
                codexThreadSource = entry.value(QStringLiteral("threadSource")).toString() == QLatin1String("subagent")
                    ? QStringLiteral("subagent")
                    : QStringLiteral("user");
                codexParentThreadId = optionalString(entry.value(QStringLiteral("parentThreadId")));
                codexAgentRole = optionalString(entry.value(QStringLiteral("agentRole")));
                codexAgentNickname = optionalString(entry.value(QStringLiteral("agentNickname")));
            } else if (type == QLatin1String("claude_import")) {
                source = QStringLiteral("claude");
            } else if (type == QLatin1String("opencode_import")) {
                source = QStringLiteral("opencode");
            }
        }

        if (name.isEmpty()) {
            name = firstString(entry, {QStringLiteral("sessionName"), QStringLiteral("name")});
            if (name.isEmpty()) name = nestedString(entry, QStringLiteral("data"), {QStringLiteral("name")});
            if (name.isEmpty()) name = nestedString(entry, QStringLiteral("session"), {QStringLiteral("name")});
        }
        if (projectPath.isEmpty()) {
            projectPath = firstString(entry, {QStringLiteral("cwd"), QStringLiteral("projectPath")});
            if (projectPath.isEmpty()) projectPath = nestedString(entry, QStringLiteral("data"), {QStringLiteral("cwd")});
            if (projectPath.isEmpty()) projectPath = nestedString(entry, QStringLiteral("session"), {QStringLiteral("cwd")});
            if (projectPath.isEmpty()) {
                projectPath = nestedString(entry.value(QStringLiteral("data")).toObject(),
                                           QStringLiteral("session"), {QStringLiteral("cwd")});
            }
        }

        if (type == QLatin1String("model_change")) {
            const QString provider = optionalString(entry.value(QStringLiteral("provider")));
            if (!provider.isEmpty()) modelProvider = provider;
            const QString changedModel = optionalString(entry.value(QStringLiteral("modelId")));
            if (!changedModel.isEmpty()) modelId = changedModel;
        } else if (type == QLatin1String("thinking_level_change")) {
            const QString level = optionalString(entry.value(QStringLiteral("thinkingLevel")));
            if (!level.isEmpty()) {
                thinkingLevel = level;
                hasThinkingLevel = true;
            }
        }

        QString goal;
        if (pitask::readTodoTaskGoal(QJsonValue(entry), &goal)) {
            ++messageCount;
            if (preview == emptyPreview) preview = goal;
            if (firstUserText.isEmpty()) firstUserText = goal;
        }
        QJsonValue messageValue = entry.value(QStringLiteral("message"));
        if (messageValue.isUndefined()) {
            messageValue = entry.value(QStringLiteral("data")).toObject().value(QStringLiteral("message"));
        }
        if (messageValue.isUndefined()) messageValue = QJsonValue(entry);
        if (!messageValue.isObject()) continue;
        const QJsonObject message = messageValue.toObject();
        const QString role = message.value(QStringLiteral("role")).toString();
        if (role.isEmpty()) continue;
        ++messageCount;
        const QString text = extractText(message.value(QStringLiteral("content"))).trimmed();
        if (!text.isEmpty() && preview == emptyPreview) preview = text;
        if (!text.isEmpty() && role == QLatin1String("user") && firstUserText.isEmpty()) firstUserText = text;
        if (!text.isEmpty() && role == QLatin1String("assistant") && firstAssistantText.isEmpty()) {
            firstAssistantText = text;
        }
        if (role == QLatin1String("assistant")) {
            const QString provider = optionalString(message.value(QStringLiteral("provider")));
            const QString model = optionalString(message.value(QStringLiteral("model")));
            if (!provider.isEmpty() && !model.isEmpty()) {
                hasLastAssistantModel = true;
                lastAssistantProvider = provider;
                lastAssistantModel = model;
            }
        }
    }

    if (validEntries == 0) {
        result.isSession = false;
        return result;
    }

    // Old sessions predate model_change/thinking_level_change; recover the model from
    // the last assistant message and treat an unrecorded thinking level as "off".
    if (modelProvider.isEmpty() || modelId.isEmpty()) {
        if (hasLastAssistantModel) {
            modelProvider = lastAssistantProvider;
            modelId = lastAssistantModel;
        }
    }
    if (!hasThinkingLevel && (!modelProvider.isEmpty() || hasLastAssistantModel)) {
        thinkingLevel = QStringLiteral("off");
        hasThinkingLevel = true;
    }

    const QString defaultRoot = scanroots::defaultSessionsRoot(context.fs, context.hostHome);
    const QString pathInferredParent =
        inferParentSessionFromPath(context.fs, context.scanRoots, filePath, defaultRoot);
    const bool hasStandardLayout = isPiSubagentLayoutPath(context.fs, filePath);
    const bool namedLikeGeneratedChild = latestSessionInfoName.startsWith(QLatin1String("subagent-"));
    const bool isKnownSubagent = context.knownSubagentSessions.contains(
        sessionidentity::normalizeScanPath(filePath));
    int score = 0;
    if (hasStandardLayout && namedLikeGeneratedChild) score += 2;
    if (hasSubagentChildMarker) score += 2;
    if (isKnownSubagent) score += 2;
    if (namedLikeGeneratedChild) score += 1;
    if (!forkParentSession.isEmpty() && (namedLikeGeneratedChild || hasStandardLayout)) score += 1;
    const bool isInternalSubagent = source == QLatin1String("pi") && score >= 2;

    QString parentSessionPath;
    if (isInternalSubagent) {
        parentSessionPath = pathInferredParent;
        if (parentSessionPath.isEmpty() && !forkParentSession.isEmpty()) {
            QString normalizedForkParent = forkParentSession;
            normalizedForkParent.replace(QLatin1Char('\\'), QLatin1Char('/'));
            QString resolved;
            if (context.fs.wsl()) {
                QString dir = context.fs.dirname(filePath);
                if (normalizedForkParent.startsWith(QLatin1Char('/'))) {
                    resolved = normalizedForkParent;
                } else {
                    resolved = dir + QLatin1Char('/') + normalizedForkParent;
                }
            } else {
                resolved = QDir::cleanPath(QDir(context.fs.dirname(filePath)).filePath(forkParentSession));
            }
            const QString normalizedResolved = sessionidentity::normalizeScanPath(resolved);
            const QString normalizedRoot =
                sessionidentity::normalizeScanPath(findSessionsRootForFile(context.fs, context.scanRoots, filePath,
                                                                           defaultRoot));
            // The header comes from an external JSONL: only an existing file inside the
            // sessions root may be adopted, otherwise a crafted header could point anywhere.
            if (normalizedResolved != normalizedRoot
                && normalizedResolved.startsWith(normalizedRoot + QLatin1Char('/'))
                && context.fs.isFile(resolved)) {
                parentSessionPath = resolved;
            }
        }
    }

    if (source == QLatin1String("codex") && !codexSourcePath.isEmpty() && codexParentThreadId.isEmpty()) {
        const CodexThreadInfo info = readCodexThreadInfo(context, codexSourcePath);
        if (!info.threadSource.isEmpty()) {
            codexThreadSource = info.threadSource;
            codexParentThreadId = info.parentThreadId;
            codexAgentRole = info.agentRole;
            codexAgentNickname = info.agentNickname;
        }
    }

    QString inferredName = cleanTitle(latestSessionInfoName);
    if (inferredName.isEmpty()) inferredName = cleanTitle(name);
    if (inferredName.isEmpty()) inferredName = cleanTitle(firstUserText);
    if (inferredName.isEmpty()) inferredName = cleanTitle(firstAssistantText);
    if (inferredName.isEmpty()) {
        inferredName = context.translate(QStringLiteral("session.untitled"), QJsonObject{});
    }

    SessionSummary summary;
    summary.filePath = filePath;
    if (!projectPath.isEmpty()) {
        summary.hasProjectPath = true;
        // The oracle lower-cases and slash-normalizes the scanned cwd so project
        // membership comparison is stable across path spellings.
        summary.projectPath = sessionidentity::normalizeScanPath(projectPath);
    } else {
        const QString inferred = inferProjectPathFromFile(filePath);
        if (!inferred.isEmpty()) {
            summary.hasProjectPath = true;
            summary.projectPath = inferred;
        }
    }
    summary.hasName = true;
    summary.name = inferredName;
    summary.preview = preview.left(kPreviewLimit);
    summary.updatedAt = mtimeMs;
    summary.messageCount = messageCount;
    summary.source = source;
    if (!codexSessionId.isEmpty()) summary.codexSessionId = codexSessionId;
    if (!codexThreadSource.isEmpty()) summary.codexThreadSource = codexThreadSource;
    if (!codexParentThreadId.isEmpty()) summary.codexParentThreadId = codexParentThreadId;
    if (!codexAgentRole.isEmpty()) summary.codexAgentRole = codexAgentRole;
    if (!codexAgentNickname.isEmpty()) summary.codexAgentNickname = codexAgentNickname;
    if (isInternalSubagent) {
        summary.hasIsInternalSubagent = true;
        summary.isInternalSubagent = true;
    }
    if (!parentSessionPath.isEmpty()) {
        summary.hasParentSessionPath = true;
        summary.parentSessionPath = parentSessionPath;
    }
    if (!modelProvider.isEmpty() && !modelId.isEmpty()) {
        summary.hasModel = true;
        summary.modelProvider = modelProvider;
        summary.modelId = modelId;
    }
    if (hasThinkingLevel) {
        summary.hasThinkingLevel = true;
        summary.thinkingLevel = thinkingLevel;
    }
    summary.wsl = context.fs.wsl();
    result.isSession = true;
    result.summary = summary;
    return result;
}

QJsonObject toJson(const SessionSummary &summary)
{
    // Field-for-field the renderer's `SessionSummary`: the summary cache persists this
    // exact object, so a cache restore must not produce a record with fewer fields than a
    // fresh scan (the renderer keys rows by `id` and reads `updatedAt` for ordering).
    QJsonObject result{
        {QStringLiteral("id"), summary.filePath},
        {QStringLiteral("filePath"), summary.filePath},
        {QStringLiteral("preview"), summary.preview},
        {QStringLiteral("updatedAt"), double(summary.updatedAt)},
        {QStringLiteral("messageCount"), summary.messageCount},
    };
    if (summary.hasProjectPath) result.insert(QStringLiteral("projectPath"), summary.projectPath);
    if (summary.hasName) result.insert(QStringLiteral("name"), summary.name);
    if (summary.hasIsInternalSubagent) {
        result.insert(QStringLiteral("isInternalSubagent"), summary.isInternalSubagent);
    }
    if (summary.hasParentSessionPath) {
        result.insert(QStringLiteral("parentSessionPath"), summary.parentSessionPath);
    }
    if (!summary.source.isEmpty()) result.insert(QStringLiteral("source"), summary.source);
    if (summary.wsl) result.insert(QStringLiteral("wsl"), true);
    if (summary.hasModel) {
        result.insert(QStringLiteral("model"), QJsonObject{
            {QStringLiteral("provider"), summary.modelProvider},
            {QStringLiteral("modelId"), summary.modelId},
        });
    }
    if (summary.hasThinkingLevel) result.insert(QStringLiteral("thinkingLevel"), summary.thinkingLevel);
    if (!summary.codexSessionId.isEmpty()) result.insert(QStringLiteral("codexSessionId"), summary.codexSessionId);
    if (!summary.codexThreadSource.isEmpty()) {
        result.insert(QStringLiteral("codexThreadSource"), summary.codexThreadSource);
    }
    if (!summary.codexParentThreadId.isEmpty()) {
        result.insert(QStringLiteral("codexParentThreadId"), summary.codexParentThreadId);
    }
    if (!summary.codexAgentRole.isEmpty()) result.insert(QStringLiteral("codexAgentRole"), summary.codexAgentRole);
    if (!summary.codexAgentNickname.isEmpty()) {
        result.insert(QStringLiteral("codexAgentNickname"), summary.codexAgentNickname);
    }
    return result;
}

bool jsonWholeMillis(const QJsonValue &value, qint64 *out)
{
    if (!value.isDouble()) return false;
    const double number = value.toDouble();
    // A malformed cache can carry numbers no stat() can produce. Dropping them keeps the
    // load path inside qint64 instead of relying on an out-of-range float→int cast.
    if (!std::isfinite(number)) return false;
    if (number < kInt64Min || number >= kInt64MaxExclusive) return false;
    // Node's `stat().mtimeMs` is fractional and the cache file is shared with the Node
    // sidecar; flooring puts both implementations on the same whole millisecond.
    if (out) *out = qint64(std::floor(number));
    return true;
}

bool fromJson(const QJsonObject &value, SessionSummary *out)
{
    const QJsonValue filePath = value.value(QStringLiteral("filePath"));
    const QJsonValue updatedAt = value.value(QStringLiteral("updatedAt"));
    qint64 updatedAtMillis = 0;
    if (!filePath.isString() || filePath.toString().isEmpty() || !jsonWholeMillis(updatedAt, &updatedAtMillis)) {
        return false;
    }
    SessionSummary summary;
    summary.filePath = filePath.toString();
    summary.preview = value.value(QStringLiteral("preview")).toString();
    summary.updatedAt = updatedAtMillis;
    summary.messageCount = value.value(QStringLiteral("messageCount")).toInt();
    summary.source = value.value(QStringLiteral("source")).toString(QStringLiteral("pi"));
    summary.wsl = value.value(QStringLiteral("wsl")).toBool(false);
    const QJsonValue projectPath = value.value(QStringLiteral("projectPath"));
    if (projectPath.isString()) {
        summary.hasProjectPath = true;
        summary.projectPath = projectPath.toString();
    }
    const QJsonValue name = value.value(QStringLiteral("name"));
    if (name.isString()) {
        summary.hasName = true;
        summary.name = name.toString();
    }
    const QJsonValue internal = value.value(QStringLiteral("isInternalSubagent"));
    if (internal.isBool()) {
        summary.hasIsInternalSubagent = true;
        summary.isInternalSubagent = internal.toBool();
    }
    const QJsonValue parent = value.value(QStringLiteral("parentSessionPath"));
    if (parent.isString()) {
        summary.hasParentSessionPath = true;
        summary.parentSessionPath = parent.toString();
    }
    const QJsonValue model = value.value(QStringLiteral("model"));
    if (model.isObject()) {
        const QJsonObject fields = model.toObject();
        summary.hasModel = true;
        summary.modelProvider = fields.value(QStringLiteral("provider")).toString();
        summary.modelId = fields.value(QStringLiteral("modelId")).toString();
    }
    const QJsonValue thinking = value.value(QStringLiteral("thinkingLevel"));
    if (thinking.isString()) {
        summary.hasThinkingLevel = true;
        summary.thinkingLevel = thinking.toString();
    }
    summary.codexSessionId = value.value(QStringLiteral("codexSessionId")).toString();
    summary.codexThreadSource = value.value(QStringLiteral("codexThreadSource")).toString();
    summary.codexParentThreadId = value.value(QStringLiteral("codexParentThreadId")).toString();
    summary.codexAgentRole = value.value(QStringLiteral("codexAgentRole")).toString();
    summary.codexAgentNickname = value.value(QStringLiteral("codexAgentNickname")).toString();
    if (out) *out = summary;
    return true;
}

} // namespace summaryreader
