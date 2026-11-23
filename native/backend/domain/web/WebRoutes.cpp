#include "WebRoutes.h"

#include <QList>
#include <QRegularExpression>
#include <QUrl>

namespace {

/**
 * First capture group, percent-decoded (decodeURIComponent on the captured segment).
 *
 * Decoding happens on the captured segment only, never on the whole path: `%2F` inside
 * a session id is a data byte, and decoding first would turn it into a separator.
 */
bool capture(const QRegularExpression &pattern, const QString &path, QString *value)
{
    const QRegularExpressionMatch match = pattern.match(path);
    if (!match.hasMatch()) return false;
    *value = QUrl::fromPercentEncoding(match.captured(1).toUtf8());
    return true;
}

QString decodeQueryComponent(const QByteArray &raw)
{
    QByteArray normalized = raw;
    normalized.replace('+', ' ');
    return QUrl::fromPercentEncoding(normalized);
}

/** Every route pattern, compiled once. Matches the oracle's regex literals verbatim. */
struct Patterns {
    QRegularExpression deleteProject{R"(^/api/projects/([^/]+)/delete$)"};
    QRegularExpression projectSessions{R"(^/api/projects/([^/]+)/sessions$)"};
    QRegularExpression projectCatalogSessions{R"(^/api/projects/([^/]+)/sessions/catalog$)"};
    QRegularExpression sessionRecord{R"(^/api/sessions/([^/]+)/(update|delete|copy|export-html)$)"};
    QRegularExpression referenceMessages{R"(^/api/sessions/([^/]+)/reference-messages$)"};
    QRegularExpression messagePage{R"(^/api/sessions/([^/]+)/messages/page$)"};
    QRegularExpression turnPage{R"(^/api/sessions/([^/]+)/messages/turn-page$)"};
    QRegularExpression messages{R"(^/api/sessions/([^/]+)/messages$)"};
    QRegularExpression prompt{R"(^/api/sessions/([^/]+)/prompt$)"};
    QRegularExpression stream{R"(^/api/sessions/([^/]+)/stream$)"};
    QRegularExpression runtime{R"(^/api/sessions/([^/]+)/runtime/(stop|abort|restart|compact|state|commands|export-html|edit-message|delete-message|prepare-resend|models|model|thinking|clone)$)"};
};

const Patterns &patterns()
{
    static const Patterns instance;
    return instance;
}

} // namespace

namespace webroute {

bool queryParameter(const QByteArray &query, const QString &name, QString *value)
{
    if (query.isEmpty()) return false;
    for (const QByteArray &pair : query.split('&')) {
        const int separator = pair.indexOf('=');
        const QByteArray rawKey = separator < 0 ? pair : pair.left(separator);
        if (decodeQueryComponent(rawKey) != name) continue;
        *value = separator < 0 ? QString() : decodeQueryComponent(pair.mid(separator + 1));
        return true;
    }
    return false;
}

Match match(const QByteArray &method, const QByteArray &rawPath)
{
    Match result;
    const QString path = QString::fromUtf8(rawPath);
    const Patterns &table = patterns();

    const bool isGet = method == "GET";
    const bool isPost = method == "POST";

    if (rawPath.startsWith(QByteArrayLiteral("/api/"))) {
        // Order is part of the contract; see WebRoutes.h.
        if (path == QLatin1String("/api/health")) {
            result.action = Action::Health;
            return result;
        }
        if (path == QLatin1String("/api/state")) {
            result.action = Action::State;
            return result;
        }
        if (isPost && path == QLatin1String("/api/ui-response")) {
            result.action = Action::UiResponse;
            return result;
        }
        if (isGet && path == QLatin1String("/api/models")) {
            result.action = Action::Models;
            return result;
        }
        if (isPost && path == QLatin1String("/api/projects")) {
            result.action = Action::CreateProject;
            return result;
        }
        if (isPost && capture(table.deleteProject, path, &result.projectId)) {
            result.action = Action::DeleteProject;
            return result;
        }
        if (isGet && capture(table.projectSessions, path, &result.projectId)) {
            result.action = Action::ProjectSessions;
            return result;
        }
        if (isGet && capture(table.projectCatalogSessions, path, &result.projectId)) {
            result.action = Action::ProjectCatalogSessions;
            return result;
        }
        if (isGet && path == QLatin1String("/api/sessions/runtimes")) {
            result.action = Action::SessionRuntimes;
            return result;
        }
        if (isPost && path == QLatin1String("/api/sessions")) {
            result.action = Action::CreateSession;
            return result;
        }
        if (isPost && path == QLatin1String("/api/sessions/anonymous")) {
            result.action = Action::CreateAnonymousSession;
            return result;
        }
        if (isPost && capture(table.sessionRecord, path, &result.sessionId)) {
            result.action = Action::SessionRecord;
            result.recordAction = table.sessionRecord.match(path).captured(2);
            return result;
        }
        if (isGet && capture(table.referenceMessages, path, &result.sessionId)) {
            result.action = Action::ReferenceMessages;
            return result;
        }
        if (isGet && capture(table.messagePage, path, &result.sessionId)) {
            result.action = Action::MessagePage;
            return result;
        }
        if (isGet && capture(table.turnPage, path, &result.sessionId)) {
            result.action = Action::TurnPage;
            return result;
        }
        if (isGet && capture(table.messages, path, &result.sessionId)) {
            result.action = Action::Messages;
            return result;
        }
        if (isPost && capture(table.prompt, path, &result.sessionId)) {
            result.action = Action::Prompt;
            return result;
        }
        if (isGet && capture(table.stream, path, &result.sessionId)) {
            result.action = Action::Stream;
            return result;
        }
        if (isPost && path == QLatin1String("/api/chat")) {
            result.action = Action::Chat;
            return result;
        }
        if (isPost && capture(table.runtime, path, &result.sessionId)) {
            result.action = Action::RuntimeAction;
            result.runtimeAction = table.runtime.match(path).captured(2);
            return result;
        }
        result.action = Action::ApiNotFound;
        return result;
    }

    result.action = Action::Asset;
    return result;
}

} // namespace webroute
