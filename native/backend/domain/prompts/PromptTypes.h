#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QVector>

/**
 * Prompt-template records shared by the manager, the channels and the store importers.
 *
 * Port of the `PiPromptTemplateSummary` / `PiPromptTemplateListResult` shapes in
 * src/shared/types/prompt.ts. The wire shape matters: the renderer distinguishes a
 * built-in entry by `path.startsWith("builtin://")` and a project entry by
 * `scope === "project"`, and `create()` deliberately returns no `scope` field (the
 * oracle's object literal omits it), so the JSON is built field by field instead of
 * from a fixed struct.
 */
namespace prompttpl {

struct Template {
    QString name;
    QString path;
    QString description;
    QString content;
    bool userCreated = true;
    /** "global" | "project"; empty means "omit the key" (create/rename results). */
    QString scope;
};

struct ListResult {
    QVector<Template> templates;
    QString globalDir;
    bool hasHiddenBuiltins = false;
};

QJsonObject toJson(const Template &item);
QJsonObject listToJson(const ListResult &result);

/** `builtin://<name>` marker used by the oracle for templates with no file on disk. */
QString builtinPrefix();
bool isBuiltinPath(const QString &path);
/** Template name encoded in a `builtin://` path (empty when the path is not built-in). */
QString builtinName(const QString &path);

} // namespace prompttpl
