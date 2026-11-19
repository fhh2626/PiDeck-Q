#include "SessionScanner.h"

#include "ScanRoots.h"
#include "SessionIdentity.h"
#include "SessionRootHistory.h"
#include "SummaryCache.h"
#include "SummaryReader.h"
#include "WslScanBatch.h"

#include "../ChannelRegistry.h"
#include "../process/BackgroundWork.h"

#include <QDateTime>
#include <QDir>
#include <QMutexLocker>
#include <QScopeGuard>
#include <QSet>

#include <algorithm>

/**
 * Scan pipeline: environment snapshot, summary cache use, and the local/WSL listing.
 *
 * Kept apart from `SessionScanner.cpp` (file-level operations) so neither unit grows into
 * a god object: this file owns "which files exist and what are their summaries", the other
 * owns rename/copy/export and the scan roots helpers shared with archive/delete.
 */
namespace {

/** Bound on the membership map; dropping it only costs a re-read of parent-cwd history. */
constexpr int kMaxMembershipEntries = 50'000;

QString membershipKey(const QString &filePath, const QString &projectPath)
{
    return filePath + QLatin1Char('\n') + projectPath;
}

} // namespace

SessionScanner::SessionScanner(Config config, maincopy::Translator translate)
    : m_config(std::move(config)), m_translate(std::move(translate))
{
    auto environment = std::make_shared<Environment>();
    environment->fs = m_config.fs;
    environment->sessionsDir = m_config.sessionsDir;
    environment->generation = 1;
    environment->roots = QStringList{m_config.sessionsDir.isEmpty()
            ? scanroots::defaultSessionsRoot(environment->fs, m_config.hostHome)
            : m_config.sessionsDir};
    m_environment = environment;
    // Same file name and userData location as the Node sidecar, so switching sidecar kind
    // reuses whatever the other implementation already computed (and vice versa).
    const QString cacheFile = m_config.userDataDir.isEmpty()
        ? QString()
        : QDir(m_config.userDataDir).filePath(QStringLiteral("session-summary-cache.json"));
    m_summaryCache = std::make_unique<summarycache::Cache>(cacheFile);
}

SessionScanner::~SessionScanner() = default;

std::shared_ptr<const SessionScanner::Environment> SessionScanner::environment() const
{
    QMutexLocker lock(&m_stateMutex);
    return m_environment;
}

SessionFs SessionScanner::fs() const
{
    return environment()->fs;
}

QStringList SessionScanner::activeScanRoots() const
{
    return environment()->roots;
}

void SessionScanner::configureEnvironment(SessionFs::Config fsConfig, const QString &sessionsDir)
{
    auto next = std::make_shared<Environment>();
    next->fs = SessionFs(std::move(fsConfig));
    next->sessionsDir = sessionsDir;
    {
        QMutexLocker lock(&m_stateMutex);
        // A new generation invalidates every in-flight read: paths from the previous
        // environment (`/home/...` vs `C:\...`) must never be interpreted by this one.
        next->generation = (m_environment ? m_environment->generation : 0) + 1;
        m_environment = next;
        if (m_scanCancel) m_scanCancel->store(true, std::memory_order_relaxed);
        m_hasCacheFileSetKey = false;
        m_cacheFileSetKey.clear();
        m_membership.clear();
    }
    // The in-memory map belongs to the previous environment. Reload instead of clearing
    // the file: the target environment's entries may already be persisted.
    //
    // The reload is a bounded but potentially multi-megabyte file read and
    // `configureEnvironment` is called on the Qt owner thread (the WSL switch publishes
    // there), so it runs on the serial domain executor — the same thread the scan bodies
    // use. `Cache::reloadFromDisk` is internally synchronized, so it needs no ownership
    // hand-off.
    scheduleSummaryCacheReload();
}

void SessionScanner::scheduleSummaryCacheReload()
{
    summarycache::Cache *cache = m_summaryCache.get();
    if (!cache) return;
    background::runBlocking(
        [cache]() -> QJsonValue {
            cache->reloadFromDisk();
            return QJsonValue();
        },
        [](background::Outcome) {});
}

void SessionScanner::publishRoots(quint64 generation, const QStringList &roots)
{
    QMutexLocker lock(&m_stateMutex);
    if (!m_environment || m_environment->generation != generation) return;
    auto next = std::make_shared<Environment>(*m_environment);
    next->roots = roots;
    m_environment = next;
}

void SessionScanner::releaseScanToken(const std::shared_ptr<std::atomic<bool>> &token)
{
    QMutexLocker lock(&m_stateMutex);
    if (m_scanCancel == token) m_scanCancel.reset();
}

void SessionScanner::assertEnvironment(quint64 generation) const
{
    if (environment()->generation != generation) {
        throw ChannelError(QStringLiteral("Session scan environment changed"));
    }
}

SessionScanner::DeletionSnapshot SessionScanner::deletionSnapshot() const
{
    const auto env = environment();
    return {env->fs, env->sessionsDir};
}

/** A catalog record is not authority to delete outside its project's session roots. */
SessionScanner::DeletionStorage SessionScanner::deletionStorage(
    const QString &filePath, const QString &projectPath, const QString &runtimeProjectPath) const
{
    return deletionStorage(filePath, projectPath, runtimeProjectPath, deletionSnapshot());
}

SessionScanner::DeletionStorage SessionScanner::deletionStorage(
    const QString &filePath, const QString &projectPath, const QString &runtimeProjectPath,
    const DeletionSnapshot &snapshot) const
{
    const auto *env = &snapshot;
    if (!filePath.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive))
        throw ChannelError(QStringLiteral("Unable to authorize session deletion"));
    QStringList roots = scanroots::resolve(env->fs, m_config.hostHome, projectPath,
                                           runtimeProjectPath, env->sessionsDir);
    // Only roots previously observed from settings in this exact environment are durable authority.
    roots.append(sessionroothistory::roots(m_config.userDataDir, env->fs, projectPath, runtimeProjectPath));
    // Importers always write to the default root even when scanning a custom root.
    roots.append(scanroots::defaultSessionsRoot(env->fs, m_config.hostHome));
    // Prefer the most specific configured root for the trash bucket. The captured
    // adapter must also be used for planning/mutation if settings switch meanwhile.
    std::sort(roots.begin(), roots.end(), [](const QString &left, const QString &right) {
        return left.size() > right.size();
    });
    for (const QString &root : roots) {
        if (env->fs.authorizeDeletionPath(filePath, {root}, true)) return {env->fs, root};
    }
    // Old catalogs cannot prove former root authority. Keep deletion fail-closed,
    // but explain the existing settings-and-refresh recovery path to the user.
    throw ChannelError(m_translate(QStringLiteral("session.deleteRootNotAuthorized"), QJsonObject{}));
}

QString SessionScanner::findRootForFile(const QString &filePath) const
{
    const auto env = environment();
    const QString normalizedFile = sessionidentity::normalizeScanPath(filePath);
    const QString fallback = env->sessionsDir.isEmpty()
        ? scanroots::defaultSessionsRoot(env->fs, m_config.hostHome)
        : env->sessionsDir;
    QString best = fallback;
    int bestLength = -1;
    const QStringList roots = env->roots.isEmpty() ? QStringList{fallback} : env->roots;
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

bool SessionScanner::isUnderProjectSessionDir(const QString &filePath, const QString &projectPath) const
{
    const auto env = environment();
    const QString normalizedFile = sessionidentity::normalizeScanPath(filePath);
    const QString defaultRoot = sessionidentity::normalizeScanPath(
        scanroots::defaultSessionsRoot(env->fs, m_config.hostHome));
    const QString normalizedProject = sessionidentity::normalizeScanPath(projectPath);
    for (const QString &root : env->roots) {
        const QString normalizedRoot = sessionidentity::normalizeScanPath(root);
        if (normalizedRoot == defaultRoot) continue;
        if (normalizedFile != normalizedRoot && !normalizedFile.startsWith(normalizedRoot + QLatin1Char('/'))) {
            continue;
        }
        // A relative sessionDir usually lives inside the project; an absolute shared
        // directory still relies on the cwd filter.
        if (normalizedRoot == normalizedProject
            || normalizedRoot.startsWith(normalizedProject + QLatin1Char('/'))) {
            return true;
        }
    }
    return false;
}

bool SessionScanner::isParentSessionForProject(const QString &sessionProject, const QString &projectPath,
                                              const QString &filePath, qint64 mtimeMs, qint64 size,
                                              const QString *raw) const
{
    // Early adopters often started pi in their home directory and then worked in a
    // sub-project; those sessions have the parent cwd but mention the project inside.
    // Only parent-cwd sessions get the content check, so unrelated home sessions do
    // not show up in every project.
    if (sessionProject.isEmpty() || !projectPath.startsWith(sessionProject + QLatin1Char('/'))) return false;
    // atime changes when a file is read; only the version the summary cache also uses is
    // part of the key, so both caches invalidate together after a real write.
    const QString key = membershipKey(filePath, projectPath);
    {
        QMutexLocker lock(&m_stateMutex);
        const auto found = m_membership.constFind(key);
        if (found != m_membership.constEnd() && found->mtimeMs == mtimeMs && found->size == size) {
            return found->matches;
        }
    }
    QString text;
    if (raw) {
        text = *raw;
    } else {
        // A cached summary has no body in scope; the oracle re-reads here as well.
        QString error;
        if (!fs().readText(filePath, &text, &error)) return false;
    }
    QString haystack = text;
    haystack.replace(QLatin1Char('\\'), QLatin1Char('/'));
    haystack = haystack.toLower();
    const bool matches = haystack.contains(projectPath);
    {
        QMutexLocker lock(&m_stateMutex);
        if (m_membership.size() >= kMaxMembershipEntries) m_membership.clear();
        m_membership.insert(key, Membership{mtimeMs, size, matches});
    }
    return matches;
}

bool SessionScanner::isSameProject(const SessionSummary &summary, const QString &projectPath, qint64 mtimeMs,
                                   qint64 size, const QString *raw) const
{
    const QString normalizedProject = sessionidentity::normalizeScanPath(projectPath);
    const QString sessionProject = summary.hasProjectPath
        ? sessionidentity::normalizeScanPath(summary.projectPath)
        : QString();
    if (sessionProject == normalizedProject) return true;
    if (isParentSessionForProject(sessionProject, normalizedProject, summary.filePath, mtimeMs, size, raw)) {
        return true;
    }
    if (isUnderProjectSessionDir(summary.filePath, projectPath)) return true;
    // Encoded cwd directories remain a fallback when decoding loses literal hyphens.
    // Match a complete ancestor component: --C-- must not claim --C---- or a filename.
    const QString normalizedFile = sessionidentity::normalizeScanPath(summary.filePath);
    const QString directoryToken = sessionidentity::safePathToken(projectPath) + QLatin1Char('/');
    return normalizedFile.startsWith(directoryToken)
        || normalizedFile.contains(QLatin1Char('/') + directoryToken);
}

bool SessionScanner::needsScanBody(const QString &path, qint64 mtimeMs, qint64 size,
                                   const QString &projectPath) const
{
    const summarycache::Cache::Value cached = m_summaryCache->get(path, mtimeMs, size);
    if (cached.lookup == summarycache::Cache::Lookup::Miss) return true;
    // A negative entry means "not a displayable session": no body is ever needed again
    // for this version.
    if (cached.lookup == summarycache::Cache::Lookup::Negative) return false;
    if (projectPath.isEmpty() || !cached.summary.hasProjectPath) return false;
    const QString project = sessionidentity::normalizeScanPath(projectPath);
    const QString parent = sessionidentity::normalizeScanPath(cached.summary.projectPath);
    if (!project.startsWith(parent + QLatin1Char('/'))) return false;
    // Parent-cwd session: the content decides membership, so the body is needed until
    // this version's membership has been decided.
    QMutexLocker lock(&m_stateMutex);
    const auto found = m_membership.constFind(membershipKey(path, project));
    return found == m_membership.constEnd() || found->mtimeMs != mtimeMs || found->size != size;
}

QVector<SessionSummary> SessionScanner::list(const QString &projectPath, const QString &runtimeProjectPath,
                                             const QHash<QString, QString> &existingSessionIds)
{
    const std::shared_ptr<const Environment> env = environment();
    const quint64 generation = env->generation;
    const SessionFs scanFs = env->fs;
    // Scan roots = default global sessions + project/global sessionDir. pi stops writing
    // encoded-cwd directories once sessionDir is configured, so both must be visited.
    const QStringList roots =
        scanroots::resolve(scanFs, m_config.hostHome, projectPath, runtimeProjectPath, env->sessionsDir);
    publishRoots(generation, roots);
    sessionroothistory::remember(m_config.userDataDir, scanFs, projectPath, runtimeProjectPath, roots);

    // After a restart the disk cache is the difference between "parse every history" and
    // "stat every history"; it is derived data, so a failure is a cold start.
    m_summaryCache->ensureLoaded();
    assertEnvironment(generation);

    QStringList files;
    QSet<QString> seen;
    for (const QString &root : roots) {
        for (const QString &file : scanFs.collectJsonl(root, false)) {
            const QString key = sessionidentity::normalizeScanPath(file);
            if (seen.contains(key)) continue;
            seen.insert(key);
            files.append(file);
        }
    }
    std::sort(files.begin(), files.end());

    {
        QMutexLocker lock(&m_stateMutex);
        // Enumeration may finish after the owner thread changed environments. Reject
        // under the same lock so this scan cannot consume the next environment's first prune.
        if (!m_environment || m_environment->generation != generation) {
            throw ChannelError(QStringLiteral("Session scan environment changed"));
        }
        const QString fileSetKey = files.join(QLatin1Char('\n'));
        if (!m_hasCacheFileSetKey || fileSetKey != m_cacheFileSetKey) {
            // Prune only the current environment's vanished files; the other environment's
            // disk entries must survive a local↔WSL toggle.
            m_summaryCache->prune(files, scanFs.wsl() ? summarycache::Cache::Mode::Wsl
                                                     : summarycache::Cache::Mode::Local);
            m_cacheFileSetKey = fileSetKey;
            m_hasCacheFileSetKey = true;
        }
    }

    summaryreader::Context context;
    context.fs = scanFs;
    context.scanRoots = roots;
    context.translate = m_translate;
    context.hostHome = m_config.hostHome;
    context.codexRoot = QDir(m_config.hostHome).filePath(QStringLiteral(".codex/sessions"));

    const auto cancel = std::make_shared<std::atomic<bool>>(false);
    {
        QMutexLocker lock(&m_stateMutex);
        if (m_environment && m_environment->generation == generation) m_scanCancel = cancel;
    }
    // Release the cancellation slot on every exit (including the two throws below), so a
    // later configureEnvironment does not write into a finished scan token.
    const auto releaseCancel = qScopeGuard([this, cancel] { releaseScanToken(cancel); });

    QVector<SessionSummary> summaries;
    summaries.reserve(files.size());
    const auto appendForProject = [&](SessionSummary summary, qint64 mtimeMs, qint64 size,
                                      const QString *raw) {
        if (!projectPath.isEmpty() && !isSameProject(summary, projectPath, mtimeMs, size, raw)) {
            // A catalog keeps project identity when a newer parser no longer recognizes
            // an old header. Only already-enumerated files with no explicit/inferred cwd
            // may use it, and the scan's captured namespace must match the stored origin.
            if (summary.hasProjectPath) return;
            const QString source = summary.source.isEmpty() ? QStringLiteral("pi") : summary.source;
            const QString originKey = sessionidentity::buildSessionOriginKey(
                source, scanFs.wsl() ? QStringLiteral("wsl") : QStringLiteral("native"), summary.filePath,
                scanFs.config().distro, scanFs.config().user,
                source == QLatin1String("codex") ? summary.codexSessionId : QString());
            summary.existingCatalogSessionId = existingSessionIds.value(originKey);
            if (summary.existingCatalogSessionId.isEmpty()) return;
            summary.existingCatalogOriginKey = originKey;
        }
        // This is a copy made after cache.set/get. The catalog fence belongs only to
        // this scan and must never contaminate a later project's cached summary.
        summaries.append(summary);
    };
    if (scanFs.wsl()) {
        wslscan::Options options;
        options.deadlineMs = m_config.wslScanTimeoutMs > 0
            ? QDateTime::currentMSecsSinceEpoch() + m_config.wslScanTimeoutMs
            : 0;
        options.bodyTimeoutMs = m_config.wslBodyTimeoutMs;
        options.cancelled = [cancel] { return cancel->load(std::memory_order_relaxed); };
        const wslscan::Execute execute =
            [scanFs](const QStringList &arguments, int timeoutMs, qint64 maxOutput) {
                return scanFs.runCapture(arguments, timeoutMs, maxOutput);
            };
        const wslscan::NeedsBody needsBody = [this, &projectPath](const QString &path,
                                                                 const wslscan::Version &version) {
            return needsScanBody(path, version.mtimeMs, version.size, projectPath);
        };
        const wslscan::Consume consume = [&](const QString &path, const wslscan::FileRead &read) {
            if (!read.hasVersion) return;
            // A failed prefetch is final for this round: not a negative cache entry, and not
            // an invitation to repeat the same timed-out read.
            if (read.body.state == wslscan::BodyState::Failed) return;
            SessionSummary summary;
            const QString *raw = nullptr;
            if (read.body.state == wslscan::BodyState::Success) {
                const summaryreader::Result result =
                    summaryreader::read(path, read.body.text, read.version.mtimeMs, context);
                if (!result.isSession) {
                    m_summaryCache->set(path, read.version.mtimeMs, read.version.size, nullptr);
                    return;
                }
                summary = result.summary;
                m_summaryCache->set(path, read.version.mtimeMs, read.version.size, &summary);
                raw = &read.body.text;
            } else {
                const summarycache::Cache::Value cached =
                    m_summaryCache->get(path, read.version.mtimeMs, read.version.size);
                if (cached.lookup != summarycache::Cache::Lookup::Hit) return;
                summary = cached.summary;
            }
            // Parent-cwd membership consumes the body/version that is still in scope
            // instead of starting another stat + cat for already-read history.
            appendForProject(summary, read.version.mtimeMs, read.version.size, raw);
        };
        const wslscan::Outcome outcome = wslscan::readBatches(files, execute, needsBody, consume, options);
        if (outcome == wslscan::Outcome::Cancelled) {
            throw ChannelError(QStringLiteral("Session scan environment changed"));
        }
        if (outcome == wslscan::Outcome::Expired) {
            throw ChannelError(QStringLiteral("Session scan timed out"));
        }
    } else {
        for (const QString &file : files) {
            if (cancel->load(std::memory_order_relaxed)) {
                throw ChannelError(QStringLiteral("Session scan environment changed"));
            }
            qint64 mtimeMs = 0;
            qint64 size = 0;
            if (!scanFs.statVersion(file, &mtimeMs, &size)) continue;
            // Stat first: an unchanged mtime + size reuses the parsed summary instead of
            // reading (and re-parsing) the whole transcript.
            const summarycache::Cache::Value cached = m_summaryCache->get(file, mtimeMs, size);
            if (cached.lookup == summarycache::Cache::Lookup::Negative) continue;
            SessionSummary summary;
            QString rawText;
            const QString *raw = nullptr;
            if (cached.lookup == summarycache::Cache::Lookup::Hit) {
                summary = cached.summary;
            } else {
                QString error;
                if (!scanFs.readText(file, &rawText, &error)) continue;
                const summaryreader::Result result =
                    summaryreader::read(file, rawText, mtimeMs, context);
                if (!result.isSession) {
                    // Empty/entirely corrupt files are cached as "not a session" so the
                    // next poll does not re-read them.
                    m_summaryCache->set(file, mtimeMs, size, nullptr);
                    continue;
                }
                summary = result.summary;
                m_summaryCache->set(file, mtimeMs, size, &summary);
                raw = &rawText;
            }
            appendForProject(summary, mtimeMs, size, raw);
        }
    }
    assertEnvironment(generation);
    std::sort(summaries.begin(), summaries.end(), [](const SessionSummary &left, const SessionSummary &right) {
        return left.updatedAt > right.updatedAt;
    });
    return summaries;
}

void SessionScanner::flushSummaryCache()
{
    m_summaryCache->flush();
}
