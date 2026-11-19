#include "SecurityCatalog.h"

#include "SecurityCatalogInternal.h"

namespace security {
namespace internal {

const QStringList kSecurityTools = {
    QStringLiteral("read"), QStringLiteral("write"), QStringLiteral("edit"), QStringLiteral("bash"),
    QStringLiteral("powershell"), QStringLiteral("grep"), QStringLiteral("find"), QStringLiteral("ls"),
    QStringLiteral("ask_question"),
};

const QStringList kDefaultDenyBashPatterns = {
    QStringLiteral("\\brm\\s+-[a-z]*[rf]"), QStringLiteral("\\brmdir\\b"),
    QStringLiteral("\\bmv\\b"), QStringLiteral("\\bcp\\b"),
    QStringLiteral("\\bchmod\\b"), QStringLiteral("\\bchown\\b"),
    QStringLiteral("\\btee\\b"), QStringLiteral("\\btruncate\\b"),
    QStringLiteral("(^|[^<])>(?!>)"), QStringLiteral(">>"),
    QStringLiteral("\\bnpm\\s+(install|uninstall|update|ci|link|publish)"),
    QStringLiteral("\\byarn\\s+(add|remove|install|publish)"),
    QStringLiteral("\\bpnpm\\s+(add|remove|install|publish)"),
    QStringLiteral("\\bpip\\s+(install|uninstall)"),
    QStringLiteral("\\bgit\\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)"),
    QStringLiteral("\\bsudo\\b"), QStringLiteral("\\bkill\\b"),
    QStringLiteral("(vim|nano|emacs|code|subl)\\b"),
};

const QStringList kDefaultDenyPowerShellPatterns = {
    QStringLiteral("\\b(Remove-Item|rm|del|erase|rmdir)\\b"),
    QStringLiteral("\\b(Set-Content|Add-Content|Clear-Content|Out-File)\\b"),
    QStringLiteral("\\b(New-Item|mkdir|ni)\\b"),
    QStringLiteral("\\b(Move-Item|mv|Copy-Item|cp|Rename-Item)\\b"),
    QStringLiteral("\\b(Set-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Acl)\\b"),
    QStringLiteral("\\b(Invoke-Expression|Start-Process|Stop-Process)\\b"),
    QStringLiteral("(^|[^<])>(?!>)"), QStringLiteral(">>"),
    QStringLiteral("\\bgit\\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|branch\\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\\b"),
    QStringLiteral("\\bnpm\\s+(install|uninstall|update|ci|publish)\\b"),
    QStringLiteral("\\bpnpm\\s+(add|install|remove|update|publish)\\b"),
    QStringLiteral("\\byarn\\s+(add|install|remove|publish)\\b"),
    QStringLiteral("\\b(winget|choco|scoop|dotnet|cargo|go)\\s+(install|add|remove|uninstall|update|upgrade|publish)\\b"),
    QStringLiteral("\\b(cmd|pwsh|powershell)(?:\\.exe)?\\s+.*(?:\\/c|\\/k|-command|-encodedcommand)\\b"),
};

QJsonArray toArray(const QStringList &values)
{
    return QJsonArray::fromStringList(values);
}

QJsonObject level(const QString &id, const QString &name, const QString &description,
                  const QJsonObject &toolActions, const QJsonArray &bashPatterns,
                  const QJsonArray &powerShellPatterns, const QString &pathPolicy,
                  bool protectSensitivePaths, const QString &defaultAction)
{
    return QJsonObject{
        {QStringLiteral("id"), id},
        {QStringLiteral("name"), name},
        {QStringLiteral("description"), description},
        {QStringLiteral("builtin"), true},
        {QStringLiteral("toolActions"), toolActions},
        {QStringLiteral("denyBashPatterns"), bashPatterns},
        {QStringLiteral("denyPowerShellPatterns"), powerShellPatterns},
        {QStringLiteral("pathPolicy"), pathPolicy},
        {QStringLiteral("customAllowDirs"), QJsonArray{}},
        {QStringLiteral("denyDirs"), QJsonArray{}},
        {QStringLiteral("protectSensitivePaths"), protectSensitivePaths},
        {QStringLiteral("defaultAction"), defaultAction},
    };
}

} // namespace internal

using internal::kDefaultDenyBashPatterns;
using internal::kDefaultDenyPowerShellPatterns;
using internal::level;
using internal::toArray;

QJsonObject defaultConfig()
{
    return QJsonObject{
        {QStringLiteral("enabled"), false},
        {QStringLiteral("defaultLevelId"), QStringLiteral("standard")},
        {QStringLiteral("levels"),
         QJsonArray{
             level(QStringLiteral("off"), QStringLiteral("关闭"),
                   QStringLiteral("完全放行所有工具调用，等同未启用安全管理。"), QJsonObject{},
                   QJsonArray{}, QJsonArray{}, QStringLiteral("unrestricted"), false,
                   QStringLiteral("allow")),
             level(QStringLiteral("standard"), QStringLiteral("标准"),
                   QStringLiteral("所有命令先确认；危险命令和敏感文件受保护，目录不限制。"),
                   QJsonObject{{QStringLiteral("bash"), QStringLiteral("ask")},
                               {QStringLiteral("powershell"), QStringLiteral("ask")}},
                   toArray(kDefaultDenyBashPatterns), toArray(kDefaultDenyPowerShellPatterns),
                   QStringLiteral("unrestricted"), true, QStringLiteral("allow")),
             level(QStringLiteral("strict"), QStringLiteral("严格"),
                   QStringLiteral("只读为主，写操作逐一确认；危险命令直接拒绝；文件访问仅限工作目录。"),
                   QJsonObject{{QStringLiteral("read"), QStringLiteral("allow")},
                               {QStringLiteral("grep"), QStringLiteral("allow")},
                               {QStringLiteral("find"), QStringLiteral("allow")},
                               {QStringLiteral("ls"), QStringLiteral("allow")},
                               {QStringLiteral("write"), QStringLiteral("ask")},
                               {QStringLiteral("edit"), QStringLiteral("ask")},
                               {QStringLiteral("bash"), QStringLiteral("ask")},
                               {QStringLiteral("powershell"), QStringLiteral("ask")},
                               {QStringLiteral("ask_question"), QStringLiteral("allow")}},
                   toArray(kDefaultDenyBashPatterns), toArray(kDefaultDenyPowerShellPatterns),
                   QStringLiteral("workspace"), true, QStringLiteral("deny")),
         }},
        {QStringLiteral("sessionOverrides"), QJsonObject{}},
    };
}

QJsonObject normalizeConfig(const QJsonObject &raw)
{
    const QJsonObject defaults = defaultConfig();
    if (raw.isEmpty()) return defaults;
    QJsonArray levels = defaults.value(QStringLiteral("levels")).toArray();
    for (const QJsonValue &value : raw.value(QStringLiteral("levels")).toArray()) {
        QJsonObject candidate = value.toObject();
        const QString id = candidate.value(QStringLiteral("id")).toString();
        if (id.isEmpty()) continue;
        // Older saved levels predate the separate PowerShell editor. Materialize the
        // extension's fallback rules so the UI displays the policy it actually enforces.
        // An explicitly empty list or user-selected action must survive this migration.
        if (!candidate.contains(QStringLiteral("denyPowerShellPatterns"))) {
            candidate.insert(QStringLiteral("denyPowerShellPatterns"),
                             id == QStringLiteral("off") ? QJsonArray{}
                                                         : toArray(kDefaultDenyPowerShellPatterns));
        }
        if ((id == QStringLiteral("standard") || id == QStringLiteral("strict"))
            && candidate.value(QStringLiteral("toolActions")).isObject()) {
            QJsonObject actions = candidate.value(QStringLiteral("toolActions")).toObject();
            if (!actions.contains(QStringLiteral("powershell"))) {
                actions.insert(QStringLiteral("powershell"), QStringLiteral("ask"));
                candidate.insert(QStringLiteral("toolActions"), actions);
            }
        }
        bool replaced = false;
        for (int index = 0; index < levels.size(); ++index) {
            if (levels.at(index).toObject().value(QStringLiteral("id")).toString() != id) continue;
            levels.replace(index, candidate);
            replaced = true;
            break;
        }
        if (!replaced) levels.append(candidate);
    }
    const QString requested = raw.value(QStringLiteral("defaultLevelId")).toString();
    bool known = false;
    for (const QJsonValue &value : levels) {
        if (value.toObject().value(QStringLiteral("id")).toString() == requested) known = true;
    }
    QJsonObject overrides;
    if (raw.value(QStringLiteral("sessionOverrides")).isObject()) {
        overrides = raw.value(QStringLiteral("sessionOverrides")).toObject();
    }
    return QJsonObject{
        {QStringLiteral("enabled"), raw.value(QStringLiteral("enabled")).toBool(false)},
        {QStringLiteral("defaultLevelId"),
         known ? requested : defaults.value(QStringLiteral("defaultLevelId"))},
        {QStringLiteral("levels"), levels},
        {QStringLiteral("sessionOverrides"), overrides},
    };
}


} // namespace security
