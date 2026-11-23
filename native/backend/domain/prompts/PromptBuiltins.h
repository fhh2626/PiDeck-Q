#pragma once

#include <QString>
#include <QStringList>
#include <QVector>

/**
 * The built-in recommended prompt templates.
 *
 * Port of `BUILTIN_TEMPLATES` in src/main/prompts/PromptManager.ts. These entries have
 * no file on disk: `path` is `builtin://<name>`, `userCreated` is false, and deleting
 * one records the name in `settings.hiddenBuiltinPromptNames` instead of touching the
 * filesystem. A user file with the same name always wins, and a hidden built-in is
 * never re-added until `prompts:restore-builtins` clears the list.
 */
namespace promptbuiltins {

struct Builtin {
    QString name;
    QString description;
    QString content;
};

/** All ten templates in declaration order (the list channel sorts them by name). */
const QVector<Builtin> &all();

/** Names in declaration order, used to validate the persisted hidden list. */
QStringList names();

/** True when `name` is one of the shipped templates. */
bool isBuiltinName(const QString &name);

} // namespace promptbuiltins
