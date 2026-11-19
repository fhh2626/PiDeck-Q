#include "PiLocator.h"

#include "ChannelContext.h"
#include "ChildEnvironment.h"
#include "PiSearchDirs.h"
#include "../wsl/WslExec.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QHash>
#include <QRegularExpression>

namespace pilocator {
namespace {

constexpr qint64 kProbeTtlMs = 60'000;

QString settingString(const QJsonObject &settings, const QString &key){
    return settings.value(key).toString().trimmed();
}

QProcessEnvironment applyPiProxyEnv(QProcessEnvironment environment, const QJsonObject &settings)
{
    if (!settings.value(QStringLiteral("piProxyEnabled")).toBool(false)) return environment;
    const QString proxyUrl = settings.value(QStringLiteral("piProxyUrl")).toString().trimmed();
    if (proxyUrl.isEmpty()) return environment;
    // Only the pi child gets the proxy: desktop updates, external links and config
    // requests must keep using the host's own proxy configuration.
    for (const char *key : {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy",
                            "all_proxy"}) {
        environment.insert(QLatin1String(key), proxyUrl);
    }
    const QString bypass = settings.value(QStringLiteral("piProxyBypass")).toString().trimmed();
    if (!bypass.isEmpty()) {
        environment.insert(QStringLiteral("NO_PROXY"), bypass);
        environment.insert(QStringLiteral("no_proxy"), bypass);
    }
    return environment;
}

QProcessEnvironment withPath(QProcessEnvironment base, const QString &pathValue)
{
    base.insert(QStringLiteral("PATH"), pathValue);
#ifdef Q_OS_WIN
    // Windows looks `Path` up by name in some child runtimes; keep both in sync.
    base.insert(QStringLiteral("Path"), pathValue);
#endif
    return base;
}

/** `distro\0user\0command` -> whether `which` found it, within the probe TTL. */
struct WslProbeCacheEntry {
    bool found = false;
    qint64 at = 0;
};

bool probeWslCommand(const ChannelServices &services, const QString &distro, const QString &user,
                     const QString &commandName)
{
    static QHash<QString, WslProbeCacheEntry> cache;
    const QString key = distro + QChar(0) + user + QChar(0) + commandName;
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    const auto cached = cache.constFind(key);
    if (cached != cache.constEnd() && now - cached->at < kProbeTtlMs) return cached->found;

    const wsl::Result result = wsl::run(
        services,
        {QStringLiteral("-d"), distro, QStringLiteral("-u"), user, QStringLiteral("which"),
         commandName},
        8'000);
    const QString found = result.stdoutText.trimmed();
    // `which` prints nothing and exits non-zero when the command is missing; a shell
    // that answers "not found" on stdout is treated the same way.
    const bool present = result.ok() && !found.isEmpty() && !found.contains(QLatin1String("not found"));
    cache.insert(key, WslProbeCacheEntry{present, now});
    return present;
}

QString resolveWslCommand(const ChannelServices &services, const QString &distro,
                          const QString &user, const QString &preference)
{
    // WSL resolves the same implementation names as Windows, except that only the
    // original `pi` and `pi-bolt` are published as distro binaries.
    const QString commandName = preference == QLatin1String("bolt") ? QStringLiteral("pi-bolt")
                                                                    : QStringLiteral("pi");
    if (!probeWslCommand(services, distro, user, commandName)) return QString();
    return QStringLiteral("wsl://%1/%2/%3").arg(distro, user, commandName);
}

} // namespace

QString normalizeCustomPath(const QString &rawPath)
{
    QString value = rawPath.trimmed();
    if (value.isEmpty()) return QString();

    static const QList<QPair<QString, QString>> quotePairs{
        {QStringLiteral("\""), QStringLiteral("\"")},
        {QStringLiteral("'"), QStringLiteral("'")},
        {QStringLiteral("\u201C"), QStringLiteral("\u201D")},
        {QStringLiteral("\u2018"), QStringLiteral("\u2019")},
    };
    bool stripped = true;
    while (stripped && value.size() >= 2) {
        stripped = false;
        for (const auto &pair : quotePairs) {
            if (value.startsWith(pair.first) && value.endsWith(pair.second)) {
                const int count = value.size() - pair.first.size() - pair.second.size();
                if (count <= 0) {
                    value.clear();
                } else {
                    value = value.mid(pair.first.size(), count).trimmed();
                }
                stripped = true;
            }
        }
    }
    if (value.isEmpty()) return value;

#ifdef Q_OS_WIN
    // A path copied out of JSON/logs can arrive with doubled backslashes.
    static const QRegularExpression doubled(R"(^(?:[a-zA-Z]:\\|\\\\))");
    if (doubled.match(value).hasMatch()) {
        value.replace(QStringLiteral("\\\\"), QStringLiteral("\\"));
    }
    // npm often emits both an extension-less script and a .cmd shim; the shim is what
    // cmd.exe can actually execute, so prefer it when the user pasted the bare path.
    if (QFileInfo(value).suffix().isEmpty()) {
        const QString cmdCandidate = value + QStringLiteral(".cmd");
        if (QFileInfo::exists(cmdCandidate)) return cmdCandidate;
        const QString exeCandidate = value + QStringLiteral(".exe");
        if (QFileInfo::exists(exeCandidate)) return exeCandidate;
    }
#endif
    return value;
}

bool isUnsupportedPowerShellShim(const QString &path)
{
#ifdef Q_OS_WIN
    return path.trimmed().endsWith(QLatin1String(".ps1"), Qt::CaseInsensitive);
#else
    Q_UNUSED(path);
    return false;
#endif
}

QString runtimeBinaryName(const QString &preference)
{
    if (preference == QLatin1String("bolt")) return QStringLiteral("pi-bolt");
    return QStringLiteral("pi");
}

QStringList candidates(const ChannelServices &services, const QString &preference)
{
    QStringList baseNames;
    if (preference == QLatin1String("typescript")) {
        baseNames << QStringLiteral("legacy-pi") << QStringLiteral("pi-ts") << QStringLiteral("pi");
    } else if (preference == QLatin1String("bolt")) {
        // Pi-Bolt only publishes `pi-bolt`; falling back to `pi` would silently start
        // the original implementation while the user asked for Bolt.
        baseNames << QStringLiteral("pi-bolt");
    } else {
        baseNames << QStringLiteral("pi");
    }
    QStringList names;
#ifdef Q_OS_WIN
    // The PowerShell shim is not auto-detected any more.
    for (const QString &name : baseNames) {
        names << name + QStringLiteral(".cmd") << name + QStringLiteral(".exe") << name;
    }
#else
    names = baseNames;
#endif
    QStringList result;
    for (const QString &dir : searchDirs(services)) {
        for (const QString &name : names) result.append(joinPath(dir, name));
    }
    return result;
}

QString resolveCommand(const ChannelServices &services, const QJsonObject &settings)
{
    const QString preference = settingString(settings, QStringLiteral("piRuntimePreference"));
    const QString customPath = settingString(settings, QStringLiteral("customPiPath"));
    const QString selectedPath = preference == QLatin1String("typescript")
        ? settingString(settings, QStringLiteral("piTypescriptPath"))
        : preference == QLatin1String("bolt") ? settingString(settings, QStringLiteral("piBoltPath"))
                                             : QString();
    const QString normalizedSelected = normalizeCustomPath(selectedPath);
    const QString normalizedCustom = normalizeCustomPath(customPath);

    // The user's manual path wins, but only in auto mode and only when it exists.
    if ((preference.isEmpty() || preference == QLatin1String("auto")) && !normalizedCustom.isEmpty()
        && !isUnsupportedPowerShellShim(normalizedCustom)
        && !normalizedCustom.startsWith(QLatin1String("wsl://"))
        && QFileInfo::exists(normalizedCustom)) {
        return normalizedCustom;
    }

#ifdef Q_OS_WIN
    const QString distro = settingString(settings, QStringLiteral("wslDistro"));
    const QString user = settingString(settings, QStringLiteral("wslUser"));
    if (settings.value(QStringLiteral("wslEnabled")).toBool(false) && !distro.isEmpty()
        && !user.isEmpty()) {
        // WSL is a different runtime: a Windows-side path must not shadow it.
        const QString wslCommand = resolveWslCommand(services, distro, user, preference);
        if (!wslCommand.isEmpty()) return wslCommand;
    }
#endif

    // A saved WSL marker must not be resolved as a Windows path either.
    if (!normalizedSelected.isEmpty() && !isUnsupportedPowerShellShim(normalizedSelected)) {
        return normalizedSelected;
    }

    for (const QString &candidate : candidates(services, preference)) {
        if (QFileInfo::exists(candidate)) return candidate;
    }
    return runtimeBinaryName(preference);
}

QString commandBinDir(const QString &command)
{
    if (!command.contains(QLatin1Char('/')) && !command.contains(QLatin1Char('\\'))) return QString();
    if (!QFileInfo::exists(command)) return QString();
    const QString binDir = QFileInfo(command).absolutePath();
#ifdef Q_OS_WIN
    const QString nodeName = QStringLiteral("node.exe");
#else
    const QString nodeName = QStringLiteral("node");
#endif
    if (!QFileInfo::exists(joinPath(binDir, nodeName))) return QString();
    return binDir;
}

QProcessEnvironment createProcessEnv(const ChannelServices &services, const QJsonObject &settings,
                                     const QString &pathPrefix, bool viaWsl)
{
    QProcessEnvironment base = QProcessEnvironment::systemEnvironment();
    if (viaWsl) {
        // wsl.exe lives in System32, so the plain process PATH stays in place; only the
        // proxy variables differ (the child reaches the network through Windows).
        QString pathValue = pathPrefix;
        if (pathValue.isEmpty()) {
            pathValue = base.value(QStringLiteral("PATH"));
            if (pathValue.isEmpty()) pathValue = base.value(QStringLiteral("Path"));
        }
        return applyPiProxyEnv(childenv::sanitized(withPath(base, pathValue)), settings);
    }

    QStringList dirs;
    if (pathPrefix.isEmpty()) {
        dirs = searchDirs(services);
    } else {
        dirs.append(pathPrefix);
        for (const QString &dir : searchDirs(services)) {
            if (dir != pathPrefix) dirs.append(dir);
        }
    }
    const QString pathValue = dirs.join(QDir::listSeparator());
    return applyPiProxyEnv(childenv::sanitized(withPath(base, pathValue)), settings);
}

QString detectRuntimeKind(const QString &version)
{
    const QString value = version.trimmed();
    if (value.isEmpty()) return QStringLiteral("unknown");
    // Pi-Bolt prints the upstream semver followed by `(Pi-Bolt <ver>, ...)`; the banner
    // is the only reliable marker and must be checked before the generic semver rule.
    static const QRegularExpression bolt(QStringLiteral("^v?\\d+\\.\\d+\\.\\d+\\b.*\\(\\s*Pi-Bolt\\b"),
                                         QRegularExpression::CaseInsensitiveOption);
    if (bolt.match(value).hasMatch()) return QStringLiteral("bolt");
    static const QRegularExpression typescript(QStringLiteral("^v?\\d+\\.\\d+\\.\\d+\\b"));
    if (typescript.match(value).hasMatch()) return QStringLiteral("typescript");
    return QStringLiteral("unknown");
}

bool parseWslUrl(const QString &url, QString *distro, QString *user, QString *piCommand)
{
    static const QRegularExpression pattern(QStringLiteral("^wsl://([^/]+)/([^/]+)/(.+)$"));
    const QRegularExpressionMatch match = pattern.match(url);
    if (!match.hasMatch()) return false;
    if (distro) *distro = match.captured(1);
    if (user) *user = match.captured(2);
    if (piCommand) *piCommand = match.captured(3);
    return true;
}

} // namespace pilocator
