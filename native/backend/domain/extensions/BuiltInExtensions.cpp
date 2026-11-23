#include "BuiltInExtensions.h"

#include <QFileInfo>
#include <QHash>
#include <QRegularExpression>

namespace builtext {
namespace {

/**
 * Shipped extension file names.
 *
 * Must stay in the same order as BUILT_IN_EXTENSIONS: pi receives the `--extension`
 * arguments in this order, and the todo/plan/ask extensions rely on being registered
 * before the generic ones.
 */
const QStringList &kNames()
{
    static const QStringList names = {
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

/** `[builtInName, keyword]`: a third-party package containing the keyword conflicts. */
const QVector<QPair<QString, QString>> &kConflicts()
{
    static const QVector<QPair<QString, QString>> conflicts = {
        {QStringLiteral("pi-deck-todo.ts"), QStringLiteral("todo")},
        {QStringLiteral("pi-deck-plan-mode.ts"), QStringLiteral("plan")},
        {QStringLiteral("pideck-q-ask-question.ts"), QStringLiteral("ask")},
        {QStringLiteral("pideck-q-webfetch.ts"), QStringLiteral("webfetch")},
        {QStringLiteral("pideck-q-subagents.ts"), QStringLiteral("subagents")},
    };
    return conflicts;
}

} // namespace

QStringList names()
{
    return kNames();
}

bool isBuiltInName(const QString &source)
{
    const QString trimmed = source.trimmed();
    // The basename check is the traversal guard: `../x` or an absolute path never
    // equals a shipped name.
    return QFileInfo(trimmed).fileName() == trimmed && kNames().contains(trimmed);
}

QHash<QString, QString> aliases()
{
    return QHash<QString, QString>{
        {QStringLiteral("pi-deck-ask-question.ts"), QStringLiteral("pideck-q-ask-question.ts")},
        {QStringLiteral("pi-deck-websearch.ts"), QStringLiteral("pideck-q-websearch.ts")},
        {QStringLiteral("pi-better-compaction.ts"), QStringLiteral("pideck-q-better-compaction.ts")},
    };
}

QStringList legacyNames()
{
    QStringList list = aliases().keys();
    // Both spellings of the retired context-controller entry point must be cleaned,
    // otherwise pi keeps auto-loading a feature that no longer ships.
    list.append(QStringLiteral("pi-deck-context-controller.ts"));
    list.append(QStringLiteral("pideck-q-context-controller.ts"));
    return list;
}

QStringList conflictKeywords()
{
    QStringList list;
    for (const auto &pair : kConflicts()) list.append(pair.first);
    return list;
}

bool extensionNameMatches(const QString &source, const QString &keyword)
{
    QString clean = source;
    static const QRegularExpression protocol(QStringLiteral("^(?:npm|file|github|git|https?):"),
                                             QRegularExpression::CaseInsensitiveOption);
    clean.remove(protocol);
    if (clean.endsWith(QLatin1String(".ts"))) clean.chop(3);
    static const QRegularExpression scope(QStringLiteral("@[^/]+/"));
    clean.remove(scope);
    return clean.contains(keyword, Qt::CaseInsensitive);
}

QString findConflict(const QStringList &thirdPartySources, const QString &builtInName)
{
    for (const auto &pair : kConflicts()) {
        if (pair.first != builtInName) continue;
        for (const QString &source : thirdPartySources) {
            if (extensionNameMatches(source, pair.second)) return source;
        }
    }
    return {};
}

} // namespace builtext
