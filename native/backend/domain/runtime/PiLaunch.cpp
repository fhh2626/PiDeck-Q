#include "PiLaunch.h"

#include "ChildEnvironment.h"
#include "CmdLine.h"
#include "../wsl/WslEnvironment.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QProcess>
#include <QRegularExpression>
#include <QSet>

namespace pilaunch {
namespace {

QString settingString(const QJsonObject &settings, const QString &key)
{
    return settings.value(key).toString().trimmed();
}

bool settingBool(const QJsonObject &settings, const QString &key, bool fallback = false)
{
    const QJsonValue value = settings.value(key);
    return value.isBool() ? value.toBool() : fallback;
}

QString preferenceBinaryName(const QString &preference)
{
    if (preference == QLatin1String("bolt")) return QStringLiteral("pi-bolt");
    return QStringLiteral("pi");
}

QStringList candidateNames()
{
#ifdef Q_OS_WIN
    return {QStringLiteral("pi.cmd"), QStringLiteral("pi.exe"), QStringLiteral("pi")};
#else
    return {QStringLiteral("pi")};
#endif
}

/** PATH search only; the full locator additionally scans package-manager dirs. */
QString searchPath(const QString &name)
{
    const QStringList names = name == QLatin1String("pi") ? candidateNames() : QStringList{name};
    const QStringList dirs = QProcessEnvironment::systemEnvironment()
                                 .value(QStringLiteral("PATH"))
                                 .split(QDir::listSeparator(), Qt::SkipEmptyParts);
    for (const QString &dir : dirs) {
        for (const QString &candidate : names) {
            const QString full = QDir(dir).filePath(candidate);
            if (QFileInfo(full).isFile()) return full;
        }
    }
    return QString();
}

bool isUnsupportedPowerShellShim(const QString &path)
{
    // A stored pi.ps1 falls back to automatic detection: the PowerShell shim is not
    // invoked anymore (it mangles argument quoting).
    return path.endsWith(QLatin1String(".ps1"), Qt::CaseInsensitive);
}

bool isWindowsAbsolutePath(const QString &path)
{
    static const QRegularExpression drive(QStringLiteral("^[A-Za-z]:[\\\\/]"));
    return drive.match(path).hasMatch() || path.startsWith(QLatin1String("\\\\"));
}

/** The built-in extension list is fixed and ordered; it mirrors BUILT_IN_EXTENSIONS. */
const QStringList &builtInExtensionNames()
{
    static const QStringList names{
        QStringLiteral("pideck-q-ask-question.ts"),
        QStringLiteral("pi-deck-nul-redirect-fix.ts"),
        QStringLiteral("pi-deck-plan-mode.ts"),
        QStringLiteral("pi-deck-security-gate.ts"),
        QStringLiteral("pi-deck-todo.ts"),
        QStringLiteral("pi-deck-vision.ts"),
        QStringLiteral("pideck-q-websearch.ts"),
        QStringLiteral("pideck-q-better-compaction.ts"),
        QStringLiteral("pideck-q-change-pi-prompt.ts"),
        QStringLiteral("pideck-q-webfetch.ts"),
        QStringLiteral("pideck-q-subagents.ts"),
    };
    return names;
}

/**
 * Windows: npm installs pi as a `pi.cmd` shim, and CreateProcess cannot execute a
 * batch file, so the shim must go through `cmd.exe /d /s /c`. A bare command name
 * takes the same path because it relies on cmd's PATHEXT lookup.
 *
 * QProcess re-quotes every argv element, which would turn the inner quotes of this
 * command line into literal backslash-quotes; `setNativeArguments` passes it through
 * untouched so cmd.exe sees exactly what /d /s /c expects.
 *
 * The quoting itself lives in `cmdline::` (`process/CmdLine.h`) so this launch path,
 * the extension/npm CLI and the locator probe cannot drift apart again: a bare
 * space/tab check let `&` in a project or install path split the command line and run
 * its tail as a second command.
 */
void wrapBatchShim(Launch *launch, const QString &versionArgument)
{
#ifdef Q_OS_WIN
    const QString programName = QFileInfo(launch->program).fileName().toLower();
    const bool isBatchShim = programName.endsWith(QLatin1String(".cmd"))
        || programName.endsWith(QLatin1String(".bat"));
    const bool isBareName = !launch->program.contains(QLatin1Char('/'))
        && !launch->program.contains(QLatin1Char('\\'));
    if (launch->viaWsl || (!isBatchShim && !isBareName)) return;
    const QString binary = launch->program;
    launch->nativeArguments = cmdline::nativeArguments(binary, launch->arguments);
    launch->nativeVersionArguments = cmdline::nativeArguments(binary, {versionArgument});
    launch->program = QStringLiteral("cmd.exe");
    launch->arguments.clear();
#else
    Q_UNUSED(launch);
    Q_UNUSED(versionArgument);
#endif
}

} // namespace

QString runtimeKind(const QJsonObject &settings, const QString &program)
{
    const QString preference = settingString(settings, QStringLiteral("piRuntimePreference"));
    if (preference == QLatin1String("bolt")) return QStringLiteral("bolt");
    const QString base = QFileInfo(program).completeBaseName().toLower();
    if (base == QLatin1String("pi-bolt")) return QStringLiteral("bolt");
    if (base == QLatin1String("pi") || base == QLatin1String("pi.cmd") || base == QLatin1String("pi.exe")) {
        return QStringLiteral("ts");
    }
    return QStringLiteral("unknown");
}

QStringList activeBuiltInExtensions(const QString &resourcesDir, const QJsonObject &settings)
{
    if (settingBool(settings, QStringLiteral("piRpcNoExtensions"))) return {};
    QSet<QString> removed;
    for (const QJsonValue &value : settings.value(QStringLiteral("removedBuiltInExtensions")).toArray()) {
        const QString name = QFileInfo(value.toString()).fileName();
        if (!name.isEmpty()) removed.insert(name);
    }
    QStringList paths;
    const QString extensionsDir = QDir(resourcesDir).filePath(QStringLiteral("extensions"));
    for (const QString &name : builtInExtensionNames()) {
        if (removed.contains(name)) continue;
        const QString full = QDir(extensionsDir).filePath(name);
        if (!QFileInfo::exists(full)) continue;
        paths.append(full);
    }
    return paths;
}

Launch build(const Request &request)
{
    const QJsonObject &settings = request.settings;
    const QString preference = settingString(settings, QStringLiteral("piRuntimePreference"));
    const QString customPath = settingString(settings, QStringLiteral("customPiPath"));
    const QString selectedPath = preference == QLatin1String("typescript")
        ? settingString(settings, QStringLiteral("piTypescriptPath"))
        : preference == QLatin1String("bolt") ? settingString(settings, QStringLiteral("piBoltPath"))
                                              : QString();

    Launch launch;
    bool resolved = false;
    // An explicit user path wins, but only in automatic mode and only when it exists.
    if ((preference.isEmpty() || preference == QLatin1String("auto")) && !customPath.isEmpty()
        && !isUnsupportedPowerShellShim(customPath) && !customPath.startsWith(QLatin1String("wsl://"))
        && QFileInfo::exists(customPath)) {
        launch.program = customPath;
        resolved = true;
    }

    const QString distro = settingString(settings, QStringLiteral("wslDistro"));
    const QString user = settingString(settings, QStringLiteral("wslUser"));
#ifdef Q_OS_WIN
    if (!resolved && settingBool(settings, QStringLiteral("wslEnabled")) && !distro.isEmpty()
        && !user.isEmpty()) {
        // WSL is a different runtime; a Windows-side path must not shadow it.
        launch.program = request.wslExe.isEmpty() ? QStringLiteral("wsl.exe") : request.wslExe;
        // `--cd` is what actually sets pi's Linux working directory (oracle
        // `PiLocator.createInvocation`). Letting `wsl.exe` translate the inherited Windows
        // cwd is not equivalent: a UNC project (or a distro whose mounts differ) silently
        // starts pi in `$HOME`, and the argv differs from the oracle for every project.
        const QString linuxCwd = toWslLinuxPath(request.projectPath, distro);
        launch.arguments = QStringList{QStringLiteral("-d"), distro, QStringLiteral("-u"), user};
        if (!linuxCwd.isEmpty()) {
            launch.arguments << QStringLiteral("--cd") << linuxCwd;
        }
        // The command follows directly (no `--`): `wsl.exe` would otherwise treat only the
        // `--`/path pair as the command line and lose pi arguments on older builds.
        launch.arguments << preferenceBinaryName(preference);
        // Remember the full wsl.exe prefix: the version probe must ask the distro's pi,
        // and the pi arguments are appended after this point. The oracle's probe passes no
        // `--cd` (PiLocator line 424), so the cwd is prepared after this copy.
        launch.versionArguments = launch.arguments;
        launch.viaWsl = true;
        resolved = true;
    }
#else
    Q_UNUSED(distro);
    Q_UNUSED(user);
#endif

    if (!resolved && !selectedPath.isEmpty() && !isUnsupportedPowerShellShim(selectedPath)) {
        launch.program = selectedPath;
        resolved = true;
    }
    if (!resolved) {
        const QString name = preferenceBinaryName(preference);
        const QString found = searchPath(name);
        launch.program = found.isEmpty() ? name : found;
    }

    const QString kind = request.detectedRuntimeKind.isEmpty()
        ? runtimeKind(settings, launch.program) : request.detectedRuntimeKind;
    launch.runtimeKind = kind;
    QStringList args = launch.viaWsl ? launch.arguments : QStringList{};
    args << QStringLiteral("--mode") << QStringLiteral("rpc") << QStringLiteral("--no-themes");
    // `--offline` is accepted by the original Pi CLI; other runtimes use the neutral form.
    if (settingBool(settings, QStringLiteral("piRpcOffline"), true) && kind == QLatin1String("ts")) {
        args << QStringLiteral("--offline");
    }
    if (settingBool(settings, QStringLiteral("piRpcNoExtensions"))) args << QStringLiteral("--no-extensions");
    if (settingBool(settings, QStringLiteral("piRpcNoSkills"))) args << QStringLiteral("--no-skills");

    if (!settingBool(settings, QStringLiteral("piRpcNoExtensions"))) {
        for (const QString &extension : activeBuiltInExtensions(request.resourcesDir, settings)) {
            args << QStringLiteral("--extension") << extension;
            // The subagents extension ships its own skills and prompt templates.
            if (QFileInfo(extension).fileName() == QLatin1String("pideck-q-subagents.ts")) {
                const QString packageDir =
                    QDir(QFileInfo(extension).absolutePath()).filePath(QStringLiteral("pideck-q-subagents"));
                const QString skillsDir = QDir(packageDir).filePath(QStringLiteral("skills"));
                const QString promptsDir = QDir(packageDir).filePath(QStringLiteral("prompts"));
                if (!settingBool(settings, QStringLiteral("piRpcNoSkills"))
                    && QFileInfo::exists(skillsDir)) {
                    args << QStringLiteral("--skill") << skillsDir;
                }
                if (QFileInfo::exists(promptsDir)) {
                    args << QStringLiteral("--prompt-template") << promptsDir;
                }
            }
        }
    }

    if (request.noSession) args << QStringLiteral("--no-session");
    if (!request.sessionPath.isEmpty() && !request.noSession) {
        args << QStringLiteral("--session") << request.sessionPath;
    }
    // PiDeck always loads project resources when the probed Pi version accepts this flag.
    if (request.approveProjectResources) {
        args << QStringLiteral("--approve");
    }

    launch.cwd = request.projectPath;
    if (launch.viaWsl) {
        // pi runs inside the distro: the session and extension paths must be Linux paths.
        for (int index = 0; index < args.size(); ++index) {
            const QString previous = index > 0 ? args.at(index - 1) : QString();
            if (previous == QLatin1String("--session") || previous == QLatin1String("--extension")
                || previous == QLatin1String("--skill") || previous == QLatin1String("--prompt-template")
                || previous == QLatin1String("-e")) {
                if (isWindowsAbsolutePath(args.at(index))) {
                    args[index] = toWslLinuxPath(args.at(index), distro);
                }
            }
        }
        // `spawnCwd` is the Windows host equivalent (oracle `toWindowsHostPath`), not the
        // raw project path: a distro-internal project only exists as a UNC share on the
        // host, and QProcess needs a path Windows can resolve. `--cd` above remains the
        // authoritative Linux working directory.
        const QString hostCwd = toWindowsHostPath(request.projectPath, distro);
        if (!hostCwd.isEmpty()) launch.cwd = hostCwd;
    }
    launch.arguments = args;

    wrapBatchShim(&launch, QStringLiteral("--version"));
    if (launch.viaWsl) {
        // `wsl.exe -d <d> -u <u> [--cd <linux cwd>] pi <args>`: the probe replaces the pi
        // arguments with `--version` and, like the oracle, keeps no `--cd`.
        launch.versionArguments = launch.versionArguments << QStringLiteral("--version");
    }

    QProcessEnvironment env = childenv::sanitized();
    if (!launch.viaWsl) {
        // The resolved pi may be a .cmd shim that needs node from the same directory.
        const QString programDir = QFileInfo(launch.program).absolutePath();
        QString path = env.value(QStringLiteral("PATH"));
        if (!programDir.isEmpty()) path = programDir + QDir::listSeparator() + path;
        env.insert(QStringLiteral("PATH"), path);
#ifdef Q_OS_WIN
        env.insert(QStringLiteral("Path"), path);
#endif
    }
    // A top-level pi must not inherit the standalone-binary marker: PiDeck may be started
    // from a Pi-Bolt shell and then run the stock Node pi, and the inherited marker would
    // make the built-in extensions treat it as a self-contained binary (no Node re-launch).
    env.remove(QStringLiteral("PIDECK_PI_STANDALONE"));
    if (launch.viaWsl) {
        const QString remaining = withoutWslEnvName(env.value(QStringLiteral("WSLENV")),
                                                     QStringLiteral("PIDECK_PI_STANDALONE"));
        if (remaining.isEmpty()) env.remove(QStringLiteral("WSLENV"));
        else env.insert(QStringLiteral("WSLENV"), remaining);
    }
    if (!request.securitySnapshotPath.isEmpty()) {
        env.insert(QStringLiteral("PIDECK_SECURITY_CONFIG"),
                   launch.viaWsl ? toWslLinuxPath(request.securitySnapshotPath)
                                : request.securitySnapshotPath);
        // The subagents extension launches its children with the same gate; it reads this
        // path from the environment instead of guessing the resources directory.
        QString gatePath;
        for (const QString &candidate : activeBuiltInExtensions(request.resourcesDir, settings)) {
            if (candidate.endsWith(QLatin1String("pi-deck-security-gate.ts"))) {
                gatePath = candidate;
                break;
            }
        }
        if (!gatePath.isEmpty()) {
            env.insert(QStringLiteral("PIDECK_SECURITY_GATE_EXTENSION"),
                       launch.viaWsl ? toWslLinuxPath(gatePath) : gatePath);
        }
        if (launch.viaWsl) {
            env.insert(QStringLiteral("WSLENV"),
                       appendWslEnvName(env.value(QStringLiteral("WSLENV")),
                                        QStringLiteral("PIDECK_SECURITY_CONFIG")));
            if (!gatePath.isEmpty()) {
                env.insert(QStringLiteral("WSLENV"),
                           appendWslEnvName(env.value(QStringLiteral("WSLENV")),
                                            QStringLiteral("PIDECK_SECURITY_GATE_EXTENSION")));
            }
        }
    }
    if (!request.securitySessionId.isEmpty()) {
        env.insert(QStringLiteral("PIDECK_SESSION_ID"), request.securitySessionId);
        if (launch.viaWsl) {
            env.insert(QStringLiteral("WSLENV"),
                       appendWslEnvName(env.value(QStringLiteral("WSLENV")),
                                        QStringLiteral("PIDECK_SESSION_ID")));
        }
    }
    if (!request.uiLocale.isEmpty()) {
        env.insert(QStringLiteral("PIDECK_UI_LANGUAGE"), request.uiLocale);
        if (launch.viaWsl) {
            env.insert(QStringLiteral("WSLENV"),
                       appendWslEnvName(env.value(QStringLiteral("WSLENV")),
                                        QStringLiteral("PIDECK_UI_LANGUAGE")));
        }
    }
    // Desktop marker: built-in extensions only enable PiDeck-consumed status channels.
    if (kind == QLatin1String("bolt")) {
        // Standalone binary (no Node + CLI script pair): extensions cannot tell it apart
        // from a renamed Node install, so the hint travels with the process.
        env.insert(QStringLiteral("PIDECK_PI_STANDALONE"), QStringLiteral("1"));
        if (launch.viaWsl) {
            env.insert(QStringLiteral("WSLENV"),
                       appendWslEnvName(env.value(QStringLiteral("WSLENV")),
                                        QStringLiteral("PIDECK_PI_STANDALONE")));
        }
    }
    env.insert(QStringLiteral("PIDECK_DESKTOP"), QStringLiteral("1"));
    if (launch.viaWsl) {
        env.insert(QStringLiteral("WSLENV"),
                   appendWslEnvName(env.value(QStringLiteral("WSLENV")), QStringLiteral("PIDECK_DESKTOP")));
    }
    launch.environment = env;
    return launch;
}

Cli buildCli(const QJsonObject &settings, const QStringList &arguments)
{
    const QString preference = settingString(settings, QStringLiteral("piRuntimePreference"));
    const QString customPath = settingString(settings, QStringLiteral("customPiPath"));
    const QString selectedPath = preference == QLatin1String("typescript")
        ? settingString(settings, QStringLiteral("piTypescriptPath"))
        : preference == QLatin1String("bolt") ? settingString(settings, QStringLiteral("piBoltPath"))
                                              : QString();

    Launch launch;
    bool resolved = false;
    if ((preference.isEmpty() || preference == QLatin1String("auto")) && !customPath.isEmpty()
        && !isUnsupportedPowerShellShim(customPath) && !customPath.startsWith(QLatin1String("wsl://"))
        && QFileInfo::exists(customPath)) {
        launch.program = customPath;
        resolved = true;
    }
    const QString distro = settingString(settings, QStringLiteral("wslDistro"));
    const QString user = settingString(settings, QStringLiteral("wslUser"));
#ifdef Q_OS_WIN
    if (!resolved && settingBool(settings, QStringLiteral("wslEnabled")) && !distro.isEmpty()
        && !user.isEmpty()) {
        launch.program = QStringLiteral("wsl.exe");
        // CLI calls carry no working directory, so the argv is exactly the oracle's
        // `createInvocation(command, args)` form: `-d <d> -u <u> <pi> <args>` (no `--`).
        launch.arguments = QStringList{QStringLiteral("-d"), distro, QStringLiteral("-u"), user,
                                      preferenceBinaryName(preference)};
        launch.viaWsl = true;
        resolved = true;
    }
#else
    Q_UNUSED(distro);
    Q_UNUSED(user);
#endif
    if (!resolved && !selectedPath.isEmpty() && !isUnsupportedPowerShellShim(selectedPath)) {
        launch.program = selectedPath;
        resolved = true;
    }
    if (!resolved) {
        const QString name = preferenceBinaryName(preference);
        const QString found = searchPath(name);
        launch.program = found.isEmpty() ? name : found;
    }
    launch.arguments = launch.viaWsl ? launch.arguments : QStringList{};
    launch.arguments.append(arguments);

    Cli cli;
    cli.viaWsl = launch.viaWsl;
    wrapBatchShim(&launch, QStringLiteral("--version"));
    cli.program = launch.program;
    cli.arguments = launch.arguments;
    cli.nativeArguments = launch.nativeArguments;

    QProcessEnvironment env = childenv::sanitized();
    if (!launch.viaWsl) {
        const QString programDir = QFileInfo(launch.program).absolutePath();
        QString path = env.value(QStringLiteral("PATH"));
        if (!programDir.isEmpty()) path = programDir + QDir::listSeparator() + path;
        env.insert(QStringLiteral("PATH"), path);
#ifdef Q_OS_WIN
        env.insert(QStringLiteral("Path"), path);
#endif
    }
    cli.environment = env;
    return cli;
}

} // namespace pilaunch
