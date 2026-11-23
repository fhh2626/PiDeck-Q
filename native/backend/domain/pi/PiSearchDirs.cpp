#include "PiSearchDirs.h"

#include "ChannelContext.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QProcess>
#include <QProcessEnvironment>
#include <QSet>

namespace pilocator {
namespace {

constexpr qint64 kProbeTtlMs = 60'000;

/** `readdirSync(parent, {withFileTypes:true}).filter(isDirectory)`, name-ordered. */
QStringList listChildDirs(const QString &parent)
{
    QStringList result;
    QDir directory(parent);
    if (!directory.exists()) return result;
    const QFileInfoList entries = directory.entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    result.reserve(entries.size());
    for (const QFileInfo &entry : entries) result.append(QDir::toNativeSeparators(entry.filePath()));
    return result;
}

/**
 * Login-shell PATH. Only POSIX needs it: Explorer-launched desktop apps on Windows
 * already inherit the merged registry PATH, and running a shell there would be both
 * slow and a quoting hazard. Cached for a minute, including failures, exactly like the
 * oracle's `SYNC_PROBE_TTL_MS` (a timed-out shell must not stall every later probe).
 */
QString loginShellPath()
{
#ifdef Q_OS_WIN
    return QString();
#else
    static QString cached;
    static qint64 cachedAt = 0;
    static bool loaded = false;
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (loaded && now - cachedAt < kProbeTtlMs) return cached;
    QString value;
    QProcess process;
    process.start(QStringLiteral("/bin/sh"),
                  {QStringLiteral("-lc"), QStringLiteral("printf %s \"$PATH\"")});
    if (process.waitForFinished(3'000)) {
        value = QString::fromUtf8(process.readAllStandardOutput()).trimmed();
    } else {
        process.kill();
        process.waitForFinished(1'000);
    }
    cached = value;
    cachedAt = now;
    loaded = true;
    return cached;
#endif
}

QStringList pathDirs()
{
    const QProcessEnvironment environment = QProcessEnvironment::systemEnvironment();
    QString fromEnv = environment.value(QStringLiteral("PATH"));
    if (fromEnv.isEmpty()) fromEnv = environment.value(QStringLiteral("Path"));
    QStringList dirs = fromEnv.split(QDir::listSeparator(), Qt::SkipEmptyParts);
    dirs.append(loginShellPath().split(QDir::listSeparator(), Qt::SkipEmptyParts));
    return dirs;
}

} // namespace

QString joinPath(const QString &parent, const QString &child)
{
    if (parent.isEmpty()) return child;
    return QDir::toNativeSeparators(QDir::cleanPath(QDir(parent).filePath(child)));
}

QStringList searchDirs(const ChannelServices &services)
{
    const QString home = services.hostHome.isEmpty() ? QDir::homePath() : services.hostHome;
    const QProcessEnvironment environment = QProcessEnvironment::systemEnvironment();
    const QString appData = environment.value(QStringLiteral("APPDATA")).isEmpty()
        ? joinPath(home, QStringLiteral("AppData/Roaming"))
        : environment.value(QStringLiteral("APPDATA"));
    const QString localAppData = environment.value(QStringLiteral("LOCALAPPDATA")).isEmpty()
        ? joinPath(home, QStringLiteral("AppData/Local"))
        : environment.value(QStringLiteral("LOCALAPPDATA"));
    // mise's data dir is overridable; only scanning the default would miss a custom
    // install root, and npm's global bin lives under the versioned node directory.
    const QString miseDataDir = environment.value(QStringLiteral("MISE_DATA_DIR")).isEmpty()
#ifdef Q_OS_WIN
        ? joinPath(localAppData, QStringLiteral("mise"))
#else
        ? joinPath(home, QStringLiteral(".local/share/mise"))
#endif
        : environment.value(QStringLiteral("MISE_DATA_DIR"));
    QString miseInstallsDir = environment.value(QStringLiteral("MISE_INSTALL_PATH"));
    if (miseInstallsDir.isEmpty()) miseInstallsDir = environment.value(QStringLiteral("MISE_INSTALLS_DIR"));
    if (miseInstallsDir.isEmpty()) miseInstallsDir = joinPath(miseDataDir, QStringLiteral("installs"));

    QStringList dirs = pathDirs();
    dirs << joinPath(appData, QStringLiteral("npm")) << joinPath(localAppData, QStringLiteral("pnpm"))
         << joinPath(localAppData, QStringLiteral("Yarn/bin"))
         << joinPath(localAppData, QStringLiteral("Volta/bin"))
         << joinPath(miseDataDir, QStringLiteral("shims"));
    for (const QString &dir : listChildDirs(joinPath(miseInstallsDir, QStringLiteral("node")))) {
        dirs.append(dir);
    }
#ifdef Q_OS_WIN
    for (const QString &dir : listChildDirs(joinPath(localAppData, QStringLiteral("fnm/node-versions")))) {
        dirs.append(joinPath(dir, QStringLiteral("installation")));
    }
    dirs << joinPath(home, QStringLiteral("scoop/shims"))
         << joinPath(home, QStringLiteral("scoop/apps/nodejs/current"));
#endif
    dirs << joinPath(home, QStringLiteral(".bun/bin")) << joinPath(home, QStringLiteral(".deno/bin"))
         << joinPath(home, QStringLiteral(".local/bin")) << joinPath(home, QStringLiteral(".npm-global/bin"))
         << joinPath(home, QStringLiteral(".nvm/current/bin"));
    for (const QString &dir : listChildDirs(joinPath(home, QStringLiteral(".nvm/versions/node")))) {
        dirs.append(joinPath(dir, QStringLiteral("bin")));
    }
    dirs << joinPath(home, QStringLiteral(".asdf/shims")) << joinPath(home, QStringLiteral(".volta/bin"));
#ifdef Q_OS_MACOS
    // A Dock/Finder launch does not inherit the terminal PATH; cover both Homebrew roots.
    dirs << QStringLiteral("/opt/homebrew/bin") << QStringLiteral("/usr/local/bin")
         << joinPath(home, QStringLiteral("Library/pnpm"))
         << joinPath(home, QStringLiteral(".fnm/current/bin"));
    for (const QString &dir : listChildDirs(joinPath(home, QStringLiteral(".fnm/node-versions")))) {
        dirs.append(joinPath(dir, QStringLiteral("installation/bin")));
    }
#endif
#ifdef Q_OS_LINUX
    dirs << QStringLiteral("/usr/local/bin") << QStringLiteral("/usr/bin");
#endif

    QStringList result;
    QSet<QString> seen;
    result.reserve(dirs.size());
    for (const QString &dir : dirs) {
        if (dir.isEmpty() || seen.contains(dir)) continue;
        seen.insert(dir);
        result.append(dir);
    }
    return result;
}

} // namespace pilocator
