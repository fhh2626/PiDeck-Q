#include "PromptTypes.h"

namespace prompttpl {

QJsonObject toJson(const Template &item)
{
    QJsonObject object{
        {QStringLiteral("name"), item.name},
        {QStringLiteral("path"), item.path},
        {QStringLiteral("description"), item.description},
        {QStringLiteral("content"), item.content},
        {QStringLiteral("userCreated"), item.userCreated},
    };
    // The oracle omits `scope` from create()/rename() results; only list entries carry it.
    if (!item.scope.isEmpty()) object.insert(QStringLiteral("scope"), item.scope);
    return object;
}

QJsonObject listToJson(const ListResult &result)
{
    QJsonArray templates;
    for (const Template &item : result.templates) templates.append(toJson(item));
    return QJsonObject{
        {QStringLiteral("templates"), templates},
        {QStringLiteral("globalDir"), result.globalDir},
        {QStringLiteral("hasHiddenBuiltins"), result.hasHiddenBuiltins},
    };
}

QString builtinPrefix()
{
    return QStringLiteral("builtin://");
}

bool isBuiltinPath(const QString &path)
{
    return path.startsWith(builtinPrefix());
}

QString builtinName(const QString &path)
{
    return isBuiltinPath(path) ? path.mid(builtinPrefix().size()) : QString();
}

} // namespace prompttpl
