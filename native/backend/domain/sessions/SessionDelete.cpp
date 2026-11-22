#include "SessionDelete.h"

#include "ScanRoots.h"
#include "SessionFiles.h"
#include "SessionScanner.h"

#include "../ChannelRegistry.h"
#include "../fs/EntryLink.h"
#include "../fs/PathPolicy.h"

#include <QDateTime>
#include <QFileInfo>
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

/** Reserved directories stay protected on both case-sensitive and insensitive macOS volumes. */
Qt::CaseSensitivity reservedNameSensitivity(const SessionFs &fs)
{
    if (fs.wsl()) return Qt::CaseSensitive;
#if defined(Q_OS_WIN) || defined(Q_OS_MACOS)
    return Qt::CaseInsensitive;
#else
    return Qt::CaseSensitive;
#endif
}

bool isArtifactContainer(const SessionFs &fs, const QString &name)
{
    for (const char *container : kNestedArtifactDirs)
        if (name.compare(QLatin1String(container), reservedNameSensitivity(fs)) == 0) return true;
    return false;
}

/** A matching stem cannot claim storage shared by sessions or infer ownership from its children. */
bool isSharedCompanion(const SessionFs &fs, const QString &directory, const QString &name)
{
    if (name.startsWith("--") && name.endsWith("--")) return true;
    const auto sensitivity = reservedNameSensitivity(fs);
    for (const auto reserved : {QLatin1String(kSharedArtifactsDir), QLatin1String(sessionfiles::kTrashDirName),
                                   QLatin1String(sessionfiles::kArchiveDirName), QLatin1String(".pi"), QLatin1String(".git")}) {
        if (name.compare(reserved, sensitivity) == 0) return true;
    }
    return fs.basename(directory).compare(QLatin1String(kSharedArtifactsDir), sensitivity) == 0
        && isArtifactContainer(fs, name);
}

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
    if (value.isUndefined() || value.isNull()) return;
    if (!value.isString() || !safeIdentity(value.toString()))
        throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
    ids->insert(value.toString());
    const QString output = outputIdentity(value.toString());
    if (!output.isEmpty()) ids->insert(output);
}

QStringList safeNames(const SessionFs &fs, const QString &directory, const QString &root)
{
    // Authorize on the storage platform: native and WSL discovery both refuse
    // directory links that could redirect ownership reads outside the session tree.
    if (!fs.authorizeDeletionPath(directory, {root}, false)) {
        throw ChannelError(QStringLiteral("Unable to verify session deletion directory"));
    }
    QStringList names;
    if (!fs.listNamesChecked(directory, &names)) {
        throw ChannelError(QStringLiteral("Unable to verify session deletion directory"));
    }
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

QSet<QString> collectSessionRunIdentities(const QString &raw, bool *uncertain)
{
    QSet<QString> ids;
    for (const QString &rawLine : raw.split(QLatin1Char('\n'))) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty()) continue;
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        // A damaged record can conceal ownership; absence of evidence is not proof
        // that another session does not own the candidate artifacts.
        if (!document.isObject())
            throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
        const QJsonObject entry = document.object();
        if (entry.value(QStringLiteral("type")).toString() != QLatin1String("message")) continue;
        const QJsonValue messageValue = entry.value(QStringLiteral("message"));
        if (!isRecord(messageValue))
            throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
        const QJsonObject message = messageValue.toObject();
        if (!message.value(QStringLiteral("role")).isString())
            throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("toolResult")) continue;
        if (!message.value(QStringLiteral("toolName")).isString())
            throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
        if (message.value(QStringLiteral("toolName")).toString() != QLatin1String("subagent")) continue;
        const QJsonValue detailsValue = message.value(QStringLiteral("details"));
        const QJsonObject details = detailsValue.toObject();
        // Pi can persist failed/aborted tool calls with an empty details object
        // as well as missing details. None proves ownership, so keep shared artifacts.
        if (uncertain && message.value(QStringLiteral("isError")).toBool()
            && (detailsValue.isUndefined() || detailsValue.isNull()
                || (detailsValue.isObject() && details.isEmpty()))) {
            *uncertain = true;
            continue;
        }
        if (!isRecord(detailsValue))
            throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
        const QString mode = details.value(QStringLiteral("mode")).toString();
        if (mode != QLatin1String("single") && mode != QLatin1String("workflow")
            && mode != QLatin1String("parallel") && mode != QLatin1String("chain")
            && mode != QLatin1String("management")) {
            throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
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
                if (children.isUndefined()) continue;
                if (!children.isArray())
                    throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
                const QJsonArray array = children.toArray();
                if (queue.size() + array.size() > kIdentityEntryLimit) {
                    throw ChannelError(QStringLiteral("Session deletion identity entry limit exceeded"));
                }
                for (const QJsonValue &child : array) {
                    if (!isRecord(child))
                        throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
                    queue.append(child.toObject());
                }
            }
            const QJsonValue summary = item.value(QStringLiteral("workflowChildren"));
            if (!summary.isUndefined()) {
                if (!isRecord(summary))
                    throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
                queue.append(summary.toObject());
            }
            if (queue.size() > kIdentityEntryLimit || ids.size() > kIdentityEntryLimit) {
                throw ChannelError(QStringLiteral("Session deletion identity entry limit exceeded"));
            }
        }
    }
    return ids;
}

Plan plan(const SessionFs &fs, const QString &inputFilePath, const QString &authorizedRoot)
{
    Plan result;
    // Only the configured/verified root may resolve a root link. A session's
    // immediate parent can be an untrusted descendant of that authority.
    if (authorizedRoot.isEmpty()) throw ChannelError(QStringLiteral("Missing session deletion authority"));
    const QString authority = authorizedRoot;
    if (!fs.wsl()) result.nativeRoot = scopedmutation::captureRoot(authority);
    const QString filePath = fs.wsl() ? inputFilePath
        : scopedmutation::mapTarget(result.nativeRoot, authority, inputFilePath);
    std::unique_ptr<scopedmutation::Parent> planningGuard;
    if (!fs.wsl()) planningGuard = std::make_unique<scopedmutation::Parent>(result.nativeRoot, filePath);
    result.sessionFile = filePath;
    const QString directory = fs.dirname(filePath);
    const QString name = fs.basename(filePath);
    const QStringList entries = safeNames(fs, directory, directory);
    // Failed probes are not evidence of absence and must never authorize deletion.
    const auto probe = [&fs](const QString &path, const QString &flag) {
        bool present = false;
        if (!fs.probeChecked(path, flag, &present))
            throw ChannelError(QStringLiteral("Unable to verify session deletion path"));
        return present;
    };
    const auto exists = [&probe](const QString &path) { return probe(path, QStringLiteral("-e")); };
    const auto isFile = [&probe](const QString &path) { return probe(path, QStringLiteral("-f")); };
    const auto isDirectory = [&probe](const QString &path) { return probe(path, QStringLiteral("-d")); };

    // A leaf link grants removal of that entry only, not ownership obtained by
    // reading its referent. A real directory is never a valid primary JSONL file.
    if (probe(filePath, QStringLiteral("-L"))) { result.hasFile = true; return result; }
    if (exists(filePath) && !isFile(filePath))
        throw ChannelError(QStringLiteral("Session deletion target is not a regular file"));

    for (const QString &entry : entries) {
        if (!isSessionEditBackupName(name, entry)) continue;
        const QString candidate = fs.join(directory, entry);
        if (isFile(candidate)) result.backups.append(candidate);
    }

    const QString sibling = filePath.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive)
        ? filePath.left(filePath.size() - 6)
        : QString();
    // A matching stem is not ownership of storage/configuration shared by sessions.
    // In particular, subagent-artifacts.jsonl must not claim every peer's artifacts.
    const bool sharedSibling = isSharedCompanion(fs, directory, fs.basename(sibling));
    if (!sibling.isEmpty() && !sharedSibling && isDirectory(sibling)) {
        result.siblingDir = sibling;
        result.hasSibling = true;
    }

    const QString artifactsDir = fs.join(directory, QLatin1String(kSharedArtifactsDir));
    if (!isDirectory(artifactsDir)) {
        result.hasFile = exists(filePath);
        return result;
    }

    qint64 bytesRead = 0;
    bool uncertainOwnership = false;
    const auto identities = [&](const QString &path) {
        QString raw;
        QString error;
        // A missing primary file is an idempotent retry. Any other read failure
        // leaves ownership unproven, so it must never authorize deleting artifacts.
        if (path == filePath && !exists(path)) return QSet<QString>{};
        if (!fs.authorizeDeletionPath(path, {directory}, false)) {
            throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
        }
        qint64 bytes = 0;
        const qint64 limit = qMin(kDeleteReadLimit, kTotalReadLimit - bytesRead);
        if (!fs.readTextBounded(path, limit, &raw, &bytes, &error)) {
            throw ChannelError(QStringLiteral("Unable to verify session artifact ownership"));
        }
        bytesRead += bytes;
        return collectSessionRunIdentities(raw, &uncertainOwnership);
    };

    const auto withSiblingIdentities = [&](const QString &path) {
        QSet<QString> ids = identities(path);
        const QString companion = path.left(path.size() - 6);
        // Shared storage cannot grant positive ownership. For peers its children
        // may still veto deletion, preserving data whose ownership is ambiguous.
        if ((path != filePath || !isSharedCompanion(fs, fs.dirname(path), fs.basename(companion)))
            && isDirectory(companion)) {
            for (const QString &candidate : safeNames(fs, companion, directory)) {
                if (isSubagentRunDirectoryName(candidate)
                    && isDirectory(fs.join(companion, candidate))) ids.insert(candidate);
            }
        }
        return ids;
    };
    QSet<QString> runIds = withSiblingIdentities(filePath);
    if (runIds.isEmpty() || uncertainOwnership) {
        result.hasFile = exists(filePath);
        return result;
    }
    // Read peers before collecting artifacts: a failed peer read cannot authorize
    // removing data another session may still need.
    QSet<QString> peerIds;
    for (const QString &peer : entries) {
        if (peer == name || !peer.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive)) continue;
        const QString peerPath = fs.join(directory, peer);
        if (!isFile(peerPath)) continue;
        peerIds.unite(withSiblingIdentities(peerPath));
        if (peerIds.size() > kIdentityEntryLimit)
            throw ChannelError(QStringLiteral("Session deletion identity entry limit exceeded"));
    }

    if (uncertainOwnership) {
        result.hasFile = exists(filePath);
        return result;
    }

    // Windows owns names case-insensitively. macOS may use either filesystem mode,
    // so only broaden peer vetoes there: an alias may preserve data, never grant
    // ownership of a distinct artifact on a case-sensitive volume.
#ifdef Q_OS_WIN
    const bool foldOwned = !fs.wsl();
#else
    constexpr bool foldOwned = false;
#endif
#if defined(Q_OS_WIN) || defined(Q_OS_MACOS)
    const bool foldPeers = !fs.wsl();
#else
    constexpr bool foldPeers = false;
#endif
    const auto normalizedIds = [](const QSet<QString> &ids, bool fold) {
        QSet<QString> normalized;
        for (const QString &id : ids) normalized.insert(fold ? id.toCaseFolded() : id);
        return normalized;
    };
    runIds = normalizedIds(runIds, foldOwned);
    peerIds = normalizedIds(peerIds, foldPeers);
    // An artifact can match several identities; retain it if any peer could own it.
    // Probe only delimiter boundaries instead of multiplying entries by identities.
    const auto matches = [](const QString &name, const QSet<QString> &ids, bool fold) {
        const QString entry = fold ? name.toCaseFolded() : name;
        if (ids.contains(entry)) return true;
        for (qsizetype i = 1; i < entry.size(); ++i) {
            if ((entry.at(i) == QLatin1Char('_') || entry.at(i) == QLatin1Char('.'))
                && ids.contains(entry.left(i))) return true;
        }
        return false;
    };
    const auto collect = [&](const QString &dir) {
        for (const QString &entry : safeNames(fs, dir, directory)) {
            // These are shared containers even if a run id happens to equal their
            // name. Their children are evaluated separately below.
            if (dir == artifactsDir && isArtifactContainer(fs, entry)) continue;
            if (matches(entry, runIds, foldOwned) && !matches(entry, peerIds, foldPeers))
                result.artifacts.append(fs.join(dir, entry));
        }
    };
    collect(artifactsDir);
    for (const char *nested : kNestedArtifactDirs) {
        const QString nestedDir = fs.join(artifactsDir, QLatin1String(nested));
        if (isDirectory(nestedDir)) collect(nestedDir);
    }
    result.hasFile = exists(filePath);
    return result;
}

/** Validate every target before mutation and unlink nested junctions without following them. */
void removePermanently(const Plan &planned)
{
    QStringList paths = planned.backups + planned.artifacts;
    if (planned.hasSibling) paths.append(planned.siblingDir);
    if (planned.hasFile) paths.append(planned.sessionFile);
    const QString root = planned.nativeRoot.path;
    const auto authorize = [&root](const QString &path) {
        if (!pathpolicy::assertAuthorized(
                path, {root}, QStringLiteral("permanent session deletion"), pathpolicy::Mode::Link).ok) {
            throw ChannelError(QStringLiteral("Unable to authorize permanent session deletion"));
        }
    };
    // Validate the complete plan before any mutation, then retain native operation
    // guards. A failed authorization is never a recycle-bin refusal.
    for (const QString &path : paths) {
        authorize(path);
        const scopedmutation::Parent guard(planned.nativeRoot, path);
    }
    for (const QString &path : paths) {
#ifdef Q_OS_WIN
        const scopedmutation::Parent guard(planned.nativeRoot, path);
        fsops::removeEntryTree(path);
#else
        scopedmutation::removeTree(planned.nativeRoot, path);
#endif
    }
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
    return sessiondelete::plan(fs(), filePath, findRootForFile(filePath));
}
