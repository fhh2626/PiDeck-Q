#include "EditorDetection.h"

#include "PiLaunch.h"
#include "process/CmdLine.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QJsonValue>
#include <QProcess>
#include <QProcessEnvironment>
#include <QRegularExpression>
#include <QStandardPaths>
#include <QStringList>

namespace editordetect {
namespace {

QStringList programFilesRoots()
{
    QStringList roots;
    const QProcessEnvironment environment = QProcessEnvironment::systemEnvironment();
    for (const QString &key : {QStringLiteral("LOCALAPPDATA"), QStringLiteral("ProgramFiles"),
                               QStringLiteral("ProgramFiles(x86)")}) {
        const QString value = environment.value(key);
        if (!value.isEmpty()) roots.append(value);
    }
    return roots;
}

/** `root/<relative>` for every Program Files root. */
QStringList underProgramFiles(const QStringList &relative)
{
    QStringList paths;
    for (const QString &root : programFilesRoots()) {
        for (const QString &entry : relative) paths.append(QDir(root).filePath(entry));
    }
    return paths;
}

std::vector<Candidate> candidates()
{
    std::vector<Candidate> list;
    list.push_back({QStringLiteral("vscode"), QStringLiteral("Visual Studio Code"),
                    {QStringLiteral("code"), QStringLiteral("code.cmd")},
                    underProgramFiles({QStringLiteral("Programs/Microsoft VS Code/Code.exe"),
                                       QStringLiteral("Microsoft VS Code/Code.exe"),
                                       QStringLiteral("Programs/Microsoft VS Code/bin/code.cmd"),
                                       QStringLiteral("Microsoft VS Code/bin/code.cmd"),
                                       QStringLiteral("Programs/Microsoft VS Code Insiders/Code - Insiders.exe"),
                                       QStringLiteral("Programs/Microsoft VS Code Insiders/bin/code-insiders.cmd"),
                                       QStringLiteral("Programs/VSCodium/VSCodium.exe"),
                                       QStringLiteral("Programs/VSCodium/bin/codium.cmd")}),
                    {QStringLiteral("Code.exe"), QStringLiteral("code.cmd")},
                    {QStringLiteral("visual studio code"), QStringLiteral("microsoft visual studio code")}});
    list.push_back({QStringLiteral("cursor"), QStringLiteral("Cursor"),
                    {QStringLiteral("cursor"), QStringLiteral("cursor.cmd")},
                    underProgramFiles({QStringLiteral("Programs/Cursor/Cursor.exe")}),
                    {QStringLiteral("Cursor.exe"), QStringLiteral("cursor.cmd")},
                    {QStringLiteral("cursor")}});
    list.push_back({QStringLiteral("zed"), QStringLiteral("Zed"),
                    {QStringLiteral("zed"), QStringLiteral("zed.cmd")},
                    underProgramFiles({QStringLiteral("Programs/Zed/Zed.exe")}),
                    {QStringLiteral("Zed.exe"), QStringLiteral("zed.cmd")},
                    {QStringLiteral("zed")}});
    list.push_back({QStringLiteral("sublime"), QStringLiteral("Sublime Text"),
                    {QStringLiteral("subl"), QStringLiteral("sublime_text")},
                    underProgramFiles({QStringLiteral("Sublime Text/sublime_text.exe"),
                                       QStringLiteral("Sublime Text 4/sublime_text.exe"),
                                       QStringLiteral("Sublime Text 3/sublime_text.exe"),
                                       QStringLiteral("Sublime Text/subl.exe"),
                                       QStringLiteral("Sublime Text 4/subl.exe"),
                                       QStringLiteral("Sublime Text 3/subl.exe")}),
                    {QStringLiteral("sublime_text.exe"), QStringLiteral("subl.exe")},
                    {QStringLiteral("sublime text"), QStringLiteral("sublime_text")}});
    struct JetBrains {
        const char *id;
        const char *name;
        const char *product;
        const char *executable;
    };
    const JetBrains jetbrains[] = {
        {"idea", "IntelliJ IDEA", "IntelliJ IDEA", "idea64.exe"},
        {"webstorm", "WebStorm", "WebStorm", "webstorm64.exe"},
        {"phpstorm", "PhpStorm", "PhpStorm", "phpstorm64.exe"},
        {"pycharm", "PyCharm", "PyCharm", "pycharm64.exe"},
    };
    for (const JetBrains &editor : jetbrains) {
        QStringList paths;
        for (const QString &version : {QStringLiteral("2025.3"), QStringLiteral("2025.2"), QStringLiteral("2025.1")}) {
            paths.append(underProgramFiles({QStringLiteral("JetBrains/%1 %2/bin/%3")
                                                .arg(QString::fromLatin1(editor.product), version,
                                                     QString::fromLatin1(editor.executable))}));
        }
        const QString id = QString::fromLatin1(editor.id);
        const QString executable = QString::fromLatin1(editor.executable);
        const QString base = id;
        list.push_back({id, QString::fromLatin1(editor.name),
                        {base, executable, base + QStringLiteral(".bat")}, paths, {executable},
                        {QString::fromLatin1(editor.product).toLower()}});
    }
    return list;
}

/**
 * PATH lookup that only accepts Windows-executable extensions.
 *
 * A cross-platform package ships `bin/code` as a shell script; spawning it fails with
 * ENOENT and the caller would fall back to opening Explorer.
 */
QString findOnPath(const QString &command)
{
    static const QStringList extensions{QStringLiteral(".exe"), QStringLiteral(".cmd"), QStringLiteral(".bat")};
    const QString pathValue = QProcessEnvironment::systemEnvironment().value(QStringLiteral("PATH"));
    const QStringList directories = pathValue.split(QDir::listSeparator(), Qt::SkipEmptyParts);
    const bool hasWindowsExtension = extensions.contains(QStringLiteral(".") + QFileInfo(command).suffix(),
                                                        Qt::CaseInsensitive);
    for (const QString &directory : directories) {
        if (hasWindowsExtension) {
            const QString full = QDir(directory).filePath(command);
            if (QFileInfo::exists(full)) return full;
            continue;
        }
        for (const QString &extension : extensions) {
            const QString full = QDir(directory).filePath(command + extension);
            if (QFileInfo::exists(full)) return full;
        }
    }
    return QString();
}

QString parseRegValue(const QString &block, const QString &name)
{
    const QStringList lines = block.split(QLatin1Char('\n'));
    for (const QString &line : lines) {
        const QString trimmed = line.trimmed();
        if (!trimmed.startsWith(name, Qt::CaseInsensitive)) continue;
        const QStringList parts = trimmed.split(QRegularExpression(QStringLiteral("\\s+")), Qt::SkipEmptyParts);
        if (parts.size() < 3) continue;
        if (!parts.at(1).startsWith(QStringLiteral("REG_"), Qt::CaseInsensitive)) continue;
        return parts.mid(2).join(QLatin1Char(' ')).trimmed();
    }
    return QString();
}

QString normalizeDisplayIcon(const QString &value)
{
    QString trimmed = value.trimmed();
    while (trimmed.startsWith(QLatin1Char('"')) || trimmed.endsWith(QLatin1Char('"'))) {
        if (trimmed.startsWith(QLatin1Char('"'))) trimmed.remove(0, 1);
        if (trimmed.endsWith(QLatin1Char('"'))) trimmed.chop(1);
    }
    static const QRegularExpression suffix(QStringLiteral(",-?\\d+$"));
    return trimmed.remove(suffix);
}

bool isLaunchableRegistryPath(const QString &path, const QStringList &executableNames)
{
    const QString extension = QStringLiteral(".") + QFileInfo(path).suffix().toLower();
    if (extension != QLatin1String(".exe") && extension != QLatin1String(".cmd")
        && extension != QLatin1String(".bat")) {
        return false;
    }
    const QString fileName = QFileInfo(path).fileName();
    for (const QString &name : executableNames) {
        if (name.compare(fileName, Qt::CaseInsensitive) == 0) return true;
    }
    return false;
}

QString findInWindowsRegistry(const Candidate &candidate)
{
#ifdef Q_OS_WIN
    if (candidate.registryNames.isEmpty() || candidate.executableNames.isEmpty()) return QString();
    const QStringList roots{
        QStringLiteral("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        QStringLiteral("HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        QStringLiteral("HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
    };
    for (const QString &root : roots) {
        QProcess process;
        process.start(QStringLiteral("reg"), {QStringLiteral("query"), root, QStringLiteral("/s")});
        if (!process.waitForFinished(10'000)) {
            process.kill();
            continue;
        }
        const QString output = QString::fromLocal8Bit(process.readAllStandardOutput());
        const QStringList blocks = output.split(QRegularExpression(QStringLiteral("\\r?\\n(?=HKEY_)")));
        for (const QString &block : blocks) {
            const QString displayName = parseRegValue(block, QStringLiteral("DisplayName")).toLower();
            if (displayName.isEmpty()) continue;
            bool matches = false;
            for (const QString &name : candidate.registryNames) {
                if (displayName.contains(name)) {
                    matches = true;
                    break;
                }
            }
            if (!matches) continue;
            const QString icon = normalizeDisplayIcon(parseRegValue(block, QStringLiteral("DisplayIcon")));
            if (!icon.isEmpty() && isLaunchableRegistryPath(icon, candidate.executableNames)
                && QFileInfo::exists(icon)) {
                return icon;
            }
            const QString location = parseRegValue(block, QStringLiteral("InstallLocation"));
            if (location.isEmpty()) continue;
            for (const QString &executableName : candidate.executableNames) {
                const QString direct = QDir(location).filePath(executableName);
                if (QFileInfo::exists(direct)) return direct;
                const QString inBin = QDir(location).filePath(QStringLiteral("bin/") + executableName);
                if (QFileInfo::exists(inBin)) return inBin;
            }
        }
    }
#else
    Q_UNUSED(candidate);
#endif
    return QString();
}

} // namespace

std::vector<Definition> supportedEditors()
{
    std::vector<Definition> list;
    for (const Candidate &candidate : candidates()) list.push_back({candidate.id, candidate.name});
    return list;
}

QJsonArray detectEditors()
{
    QJsonArray editors;
    QStringList seen;
    for (const Candidate &candidate : candidates()) {
        QString command;
        QString detectedFrom = QStringLiteral("path");
        for (const QString &cli : candidate.commands) {
            command = findOnPath(cli);
            if (!command.isEmpty()) break;
        }
        if (command.isEmpty()) {
            for (const QString &commonPath : candidate.commonPaths) {
                if (!QFileInfo::exists(commonPath)) continue;
                command = commonPath;
                detectedFrom = QStringLiteral("common-path");
                break;
            }
        }
        if (command.isEmpty()) {
            command = findInWindowsRegistry(candidate);
            if (!command.isEmpty()) detectedFrom = QStringLiteral("common-path");
        }
        if (command.isEmpty() || seen.contains(candidate.id)) continue;
        seen.append(candidate.id);
        editors.append(QJsonObject{
            {QStringLiteral("id"), candidate.id},
            {QStringLiteral("name"), candidate.name},
            {QStringLiteral("command"), command},
            {QStringLiteral("detectedFrom"), detectedFrom},
        });
    }
    return editors;
}

QString resolveLaunchableCommand(const QString &command)
{
#ifndef Q_OS_WIN
    return command;
#else
    const QString suffix = QFileInfo(command).suffix().toLower();
    if (suffix == QLatin1String("exe")) return QFileInfo::exists(command) ? command : QString();
    // A `bin/code` shim sits next to the GUI executable; prefer the GUI binary so the
    // launch does not depend on cmd/start.
    const QDir directory = QFileInfo(command).absoluteDir();
    for (const QString &name : {QStringLiteral("../Code.exe"), QStringLiteral("../Code - Insiders.exe"),
                                QStringLiteral("../VSCodium.exe")}) {
        const QString candidate = QDir::cleanPath(directory.filePath(name));
        if (QFileInfo::exists(candidate)) return candidate;
    }
    if (suffix != QLatin1String("cmd") && suffix != QLatin1String("bat")) {
        for (const QString &extension : {QStringLiteral(".cmd"), QStringLiteral(".bat"), QStringLiteral(".exe")}) {
            const QString candidate = command + extension;
            if (QFileInfo::exists(candidate)) return candidate;
        }
    }
    if (suffix == QLatin1String("cmd") || suffix == QLatin1String("bat")) {
        return QFileInfo::exists(command) ? command : QString();
    }
    return QString();
#endif
}

QJsonArray listConfiguredEditors(const QJsonObject &settings)
{
    QJsonArray editors;
    const QJsonObject configured = settings.value(QStringLiteral("externalEditors")).toObject();
    for (const Definition &definition : supportedEditors()) {
        const QJsonObject entry = configured.value(definition.id).toObject();
        if (!entry.value(QStringLiteral("enabled")).toBool(false)) continue;
        const QString command = entry.value(QStringLiteral("command")).toString();
        if (command.isEmpty()) continue;
        const QString resolved = resolveLaunchableCommand(command);
        if (resolved.isEmpty() || !QFileInfo::exists(resolved)) continue;
        editors.append(QJsonObject{
            {QStringLiteral("id"), definition.id},
            {QStringLiteral("name"), definition.name},
            {QStringLiteral("command"), resolved},
            {QStringLiteral("detectedFrom"),
             entry.value(QStringLiteral("detectedFrom")).toString(QStringLiteral("manual"))},
        });
    }
    return editors;
}

QJsonObject mergeDetectedEditors(const QJsonObject &current, const QJsonArray &detected)
{
    QJsonObject next = current;
    for (const QJsonValue &value : detected) {
        const QJsonObject editor = value.toObject();
        const QString id = editor.value(QStringLiteral("id")).toString();
        if (id.isEmpty()) continue;
        const QJsonObject existing = next.value(id).toObject();
        // A command the user typed by hand is never overwritten by detection.
        if (existing.value(QStringLiteral("detectedFrom")).toString() == QLatin1String("manual")
            && !existing.value(QStringLiteral("command")).toString().isEmpty()) {
            continue;
        }
        next.insert(id, QJsonObject{
                           {QStringLiteral("enabled"), true},
                           {QStringLiteral("command"), editor.value(QStringLiteral("command"))},
                           {QStringLiteral("detectedFrom"), editor.value(QStringLiteral("detectedFrom"))},
                           {QStringLiteral("updatedAt"), static_cast<double>(QDateTime::currentMSecsSinceEpoch())},
                       });
    }
    return next;
}

bool openProjectInEditor(const QString &editorId, const QString &command, const QStringList &args,
                         const QString &projectPath, QString *error)
{
    const QString launchCommand = resolveLaunchableCommand(command);
    const QString resolved = launchCommand.isEmpty() ? command : launchCommand;
    // Oracle `toWindowsCompatiblePath`: a WSL project arrives as a POSIX path, and only the
    // `/mnt/<drive>/...` form can be mapped without knowing the distro (`/home/...` needs a
    // WSL remote, which a plain editor cannot open). Unknown shapes stay untouched.
    const QString resolvedPath = projectPath.startsWith(QLatin1Char('/'))
        ? pilaunch::toWindowsHostPath(projectPath)
        : projectPath;
    QStringList launchArgs = args;
    if (editorId == QLatin1String("vscode")) launchArgs.append(QStringLiteral("--new-window"));
    launchArgs.append(resolvedPath);

#ifdef Q_OS_WIN
    const QString suffix = QFileInfo(resolved).suffix().toLower();
    const bool needsCmd = suffix == QLatin1String("cmd") || suffix == QLatin1String("bat");
    if (needsCmd) {
        // Batch shims must go through `start`; a detached spawn opens a console window.
        // Every path is quoted with the oracle's editor rule, otherwise a project directory
        // containing `&`, `(`, `^`, `,`, `=` or `;` truncates the command and the editor
        // opens the wrong folder (or runs the tail as a command). The `/c` payload is
        // handed over as *native* arguments: Qt's per-argument quoting mangles a command
        // line that already contains quotes, and cmd.exe would then never run the shim.
        QString inner = QStringLiteral("start \"\" %1").arg(cmdline::startArgument(resolved));
        for (const QString &argument : launchArgs) {
            inner += QLatin1Char(' ') + cmdline::startArgument(argument);
        }
        const QString program = QProcessEnvironment::systemEnvironment()
                                    .value(QStringLiteral("ComSpec"), QStringLiteral("cmd.exe"));
        QProcess process;
        process.setProgram(program);
        process.setNativeArguments(QStringLiteral("/d /s /c ") + inner);
        if (process.startDetached()) return true;
        if (error) {
            *error = QStringLiteral("Unable to start editor: %1").arg(resolved);
        }
        return false;
    }
#endif
    if (QProcess::startDetached(resolved, launchArgs)) return true;
    if (error) {
        *error = QStringLiteral("Unable to start editor: %1").arg(resolved);
    }
    return false;
}

} // namespace editordetect
