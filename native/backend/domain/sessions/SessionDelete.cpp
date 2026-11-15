#include "SessionDelete.h"

#include "ScanRoots.h"
#include "SessionFiles.h"
#include "SessionScanner.h"

#include "../ChannelRegistry.h"

#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QUuid>

namespace sessiondelete {

const char *const kSharedArtifactsDir = "subagent-artifacts";

namespace {

constexpr int kDirectoryEntryLimit = 10'000;
constexpr int kIdentityEntryLimit = 10'000;
constexpr qint64 kDeleteReadLimit = 64 * 1024 * 1024;
constexpr qint64 kTotalReadLimit = 256 * 1024 * 1024;

const char *const kNestedArtifactDirs[] = {"outputs", "structured-output"};

bool isRecord(const QJsonValue &value)
{
    return value.isObject();
}

/** Portable producer ids only; rejecting paths keeps result data inside the root. */
bool safeIdentity(const QString &value)
{
    if (value.isEmpty() || value.size() > 255) return false;
    static const QRegularExpression allowed(QStringLiteral("^[A-Za-z0-9_%~.!()'-]+$"));
    if (!allowed.match(value).hasMatch()) return false;
    if (value == QLatin1String(".") || value == QLatin1String("..")) return false;
    if (value.endsWith(QLatin1Char('.'))) return false;
    static const QRegularExpression reserved(
        QStringLiteral("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)"), QRegularExpression::CaseInsensitiveOption);
    return !reserved.match(value).hasMatch();
}

/** Mirrors the bundled producer's sanitizeRunPathSegment for managed output dirs. */
QString outputIdentity(const QString &value)
{
    QString sanitized = value.trimmed();
    static const QRegularExpression disallowed(QStringLiteral("[^A-Za-z0-9._-]+"));
    sanitized.replace(disallowed, QStringLiteral("_"));
    while (sanitized.startsWith(QLatin1Char('_'))) sanitized.remove(0, 1);
    while (sanitized.endsWith(QLatin1Char('_'))) sanitized.chop(1);
    if (sanitized.toUtf8().size() > 120) {
        sanitized = sanitized.left(120);
        while (sanitized.endsWith(QLatin1Char('_'))) sanitized.chop(1);
    }
    return sanitized;
}

void addIdentity(QSet<QString> *ids, const QJsonValue &value)
{
    if (!value.isString() || !safeIdentity(value.toString())) return;
    ids->insert(value.toString());
    const QString output = outputIdentity(value.toString());
    if (!output.isEmpty()) ids->insert(output);
}

QStringList safeNames(const SessionFs &fs, const QString &directory)
{
    const QStringList names = fs.listNames(directory);
    if (names.size() > kDirectoryEntryLimit) {
        throw ChannelError(QStringLiteral("Session deletion directory entry limit exceeded"));
    }
    for (const QString &name : names) {
        if (name.isEmpty() || name == QLatin1String(".") || name == QLatin1String("..")
            || name.contains(QLatin1Char('/')) || name.contains(QLatin1Char('\\'))
            || name.contains(QLatin1Char('\r')) || name.contains(QLatin1Char('\n'))
            || name.contains(QChar(0))) {
            throw ChannelError(QStringLiteral("Invalid session deletion directory entry"));
        }
    }
    return names;
}

} // namespace

bool isSessionEditBackupName(const QString &sessionFileName, const QString &candidate)
{
    const QString prefix = sessionFileName + QLatin1Char('.');
    const QString suffix = QStringLiteral(".edit-backup");
    if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) return false;
    const QString middle = candidate.mid(prefix.size(), candidate.size() - prefix.size() - suffix.size());
    static const QRegularExpression pattern(
        QStringLiteral("^\\d{13,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
        QRegularExpression::CaseInsensitiveOption);
    return pattern.match(middle).hasMatch();
}

bool isSubagentRunDirectoryName(const QString &name)
{
    static const QRegularExpression pattern(
        QStringLiteral("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
        QRegularExpression::CaseInsensitiveOption);
    return pattern.match(name).hasMatch();
}

QSet<QString> collectSessionRunIdentities(const QString &raw)
{
    QSet<QString> ids;
    for (const QString &rawLine : raw.split(QLatin1Char('\n'))) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty()) continue;
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        if (!document.isObject()) continue;
        const QJsonObject entry = document.object();
        if (entry.value(QStringLiteral("type")).toString() != QLatin1String("message")) continue;
        const QJsonValue messageValue = entry.value(QStringLiteral("message"));
        if (!isRecord(messageValue)) continue;
        const QJsonObject message = messageValue.toObject();
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("toolResult")) continue;
        if (message.value(QStringLiteral("toolName")).toString() != QLatin1String("subagent")) continue;
        const QJsonValue detailsValue = message.value(QStringLiteral("details"));
        if (!isRecord(detailsValue)) continue;
        const QJsonObject details = detailsValue.toObject();
        const QString mode = details.value(QStringLiteral("mode")).toString();
        if (mode != QLatin1String("single") && mode != QLatin1String("workflow")
            && mode != QLatin1String("parallel") && mode != QLatin1String("chain")) {
            continue;
        }
        // Only known identity envelopes are visited: workflow.value, text, prompts and
        // paths are output prose, never ownership evidence.
        QVector<QJsonObject> queue{details};
        for (int index = 0; index < queue.size(); ++index) {
            const QJsonObject item = queue.at(index);
            addIdentity(&ids, item.value(QStringLiteral("runId")));
            addIdentity(&ids, item.value(QStringLiteral("asyncId")));
            addIdentity(&ids, item.value(QStringLiteral("workflowRunId")));
            for (const char *key : {"results", "children"}) {
                const QJsonValue children = item.value(QLatin1String(key));
                if (!children.isArray()) continue;
                const QJsonArray array = children.toArray();
                if (queue.size() + array.size() > kIdentityEntryLimit) {
                    throw ChannelError(QStringLiteral("Session deletion identity entry limit exceeded"));
                }
                for (const QJsonValue &child : array) {
                    if (isRecord(child)) queue.append(child.toObject());
                }
            }
            const QJsonValue summary = item.value(QStringLiteral("workflowChildren"));
            if (isRecord(summary)) queue.append(summary.toObject());
            if (queue.size() > kIdentityEntryLimit || ids.size() > kIdentityEntryLimit) {
                throw ChannelError(QStringLiteral("Session deletion identity entry limit exceeded"));
            }
        }
    }
    return ids;
}

Plan plan(const SessionFs &fs, const QString &filePath)
{
    Plan result;
    const QString directory = fs.dirname(filePath);
    const QString name = fs.basename(filePath);
    const QStringList entries = safeNames(fs, directory);

    for (const QString &entry : entries) {
        if (!isSessionEditBackupName(name, entry)) continue;
        const QString candidate = fs.join(directory, entry);
        if (fs.isFile(candidate)) result.backups.append(candidate);
    }

    const QString sibling = filePath.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive)
        ? filePath.left(filePath.size() - 6)
        : QString();
    if (!sibling.isEmpty() && fs.isDirectory(sibling)) {
        result.siblingDir = sibling;
        result.hasSibling = true;
    }

    const QString artifactsDir = fs.join(directory, QLatin1String(kSharedArtifactsDir));
    if (!fs.isDirectory(artifactsDir)) {
        result.hasFile = fs.exists(filePath);
        return result;
    }

    qint64 bytesRead = 0;
    const auto identities = [&](const QString &path) {
        QString raw;
        QString error;
        if (!fs.readText(path, &raw, &error)) return QSet<QString>{};
        const qint64 bytes = raw.toUtf8().size();
        bytesRead += bytes;
        if (bytes > kDeleteReadLimit || bytesRead > kTotalReadLimit) {
            throw ChannelError(QStringLiteral("Session deletion ownership read limit exceeded"));
        }
        return collectSessionRunIdentities(raw);
    };

    QSet<QString> runIds = identities(filePath);
    if (result.hasSibling) {
        for (const QString &candidate : safeNames(fs, sibling)) {
            if (!isSubagentRunDirectoryName(candidate)) continue;
            if (fs.isDirectory(fs.join(sibling, candidate))) runIds.insert(candidate);
        }
    }
    if (runIds.isEmpty()) {
        result.hasFile = fs.exists(filePath);
        return result;
    }
    // Read peers before collecting artifacts: a failed peer read cannot authorize
    // removing data another session may still need.
    for (const QString &peer : entries) {
        if (peer == name || !peer.endsWith(QLatin1String(".jsonl"))) continue;
        const QString peerPath = fs.join(directory, peer);
        if (!fs.isFile(peerPath)) continue;
        for (const QString &id : identities(peerPath)) runIds.remove(id);
    }

    const auto collect = [&](const QString &dir) {
        for (const QString &entry : safeNames(fs, dir)) {
            bool owned = false;
            for (const QString &runId : runIds) {
                if (entry == runId || entry.startsWith(runId + QLatin1Char('_'))
                    || entry.startsWith(runId + QLatin1Char('.'))) {
                    owned = true;
                    break;
                }
            }
            if (owned) result.artifacts.append(fs.join(dir, entry));
        }
    };
    collect(artifactsDir);
    for (const char *nested : kNestedArtifactDirs) {
        const QString nestedDir = fs.join(artifactsDir, QLatin1String(nested));
        if (fs.isDirectory(nestedDir)) collect(nestedDir);
    }
    result.hasFile = fs.exists(filePath);
    return result;
}

QString wslTrashBucket(const SessionFs &fs, const QString &root)
{
    const QString stamp = QString::number(QDateTime::currentMSecsSinceEpoch()) + QLatin1Char('-')
        + QUuid::createUuid().toString(QUuid::Id128);
    return fs.join(fs.join(root, QLatin1String(sessionfiles::kTrashDirName)), stamp);
}

} // namespace sessiondelete

sessiondelete::Plan SessionScanner::planDelete(const QString &filePath) const
{
    return sessiondelete::plan(fs(), filePath);
}

QString SessionScanner::softDeleteWsl(const QString &filePath)
{
    const QString root = findRootForFile(filePath);
    const sessiondelete::Plan planned = sessiondelete::plan(fs(), filePath);
    if (!planned.hasFile && !planned.hasSibling && planned.backups.isEmpty()
        && planned.artifacts.isEmpty()) {
        return QString();
    }
    const QString bucket = sessiondelete::wslTrashBucket(fs(), root);
    if (!fs().makeDirectory(bucket)) {
        throw ChannelError(QStringLiteral("Unable to create the session trash directory"));
    }
    QString error;
    const QString artifactsDir = fs().join(fs().dirname(filePath),
                                                  QLatin1String(sessiondelete::kSharedArtifactsDir));
    for (const QString &artifact : planned.artifacts) {
        QString relative = artifact;
        if (artifact.startsWith(artifactsDir + QLatin1Char('/'))) {
            relative = artifact.mid(artifactsDir.size() + 1);
        } else {
            relative = fs().basename(artifact);
        }
        const QString destination = fs().join(
            fs().join(bucket, QLatin1String(sessiondelete::kSharedArtifactsDir)), relative);
        fs().makeDirectory(fs().dirname(destination));
        if (!fs().moveNoClobber(artifact, destination, &error)) throw ChannelError(error);
    }
    for (const QString &backup : planned.backups) {
        if (!fs().moveNoClobber(backup, fs().join(bucket, fs().basename(backup)), &error)) {
            throw ChannelError(error);
        }
    }
    if (planned.hasSibling) {
        if (!fs().moveNoClobber(planned.siblingDir,
                                       fs().join(bucket, fs().basename(planned.siblingDir)),
                                       &error)) {
            throw ChannelError(error);
        }
    }
    if (planned.hasFile) {
        if (!fs().moveNoClobber(filePath, fs().join(bucket, fs().basename(filePath)),
                                       &error)) {
            throw ChannelError(error);
        }
    }
    return bucket;
}
