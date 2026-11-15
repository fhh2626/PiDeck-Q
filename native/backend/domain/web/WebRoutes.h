#pragma once

#include <QByteArray>
#include <QString>

/**
 * Route table for the LAN web service (port of `WebServiceManager.handleRequest`).
 *
 * Registration order is load bearing and mirrors the oracle's if-chain:
 *  - `/api/sessions/:id/messages/page` must be tried before `/messages`;
 *  - a pattern that matches the path but not the method falls through, so
 *    `GET /api/projects/:id/delete` answers the generic API 404 instead of 405
 *    (the oracle only guards with `&& request.method === "POST"`).
 *
 * Paths are matched in their *encoded* form and only the captured segment is
 * percent-decoded, because the oracle matches against `url.pathname`. Decoding first
 * would let `%2F` in a session id silently become a path separator.
 */
namespace webroute {

enum class Action {
    Health,
    State,
    UiResponse,
    Models,
    CreateProject,
    DeleteProject,
    ProjectSessions,
    ProjectCatalogSessions,
    SessionRuntimes,
    CreateSession,
    CreateAnonymousSession,
    /** `:id/(update|delete|copy|export-html)`; see `recordAction`. */
    SessionRecord,
    ReferenceMessages,
    MessagePage,
    TurnPage,
    Messages,
    Prompt,
    /** SSE endpoints: routed, but the pi-event translator is a later stage. */
    Stream,
    Chat,
    /** `:id/runtime/:action`; see `runtimeAction`. */
    RuntimeAction,
    /** Not an `/api/` path: serve the browser bundle. */
    Asset,
    /** `/api/` path with no matching route: 404 `webError.apiNotFound`. */
    ApiNotFound,
};

struct Match {
    Action action = Action::ApiNotFound;
    /** Percent-decoded path segment, empty when the route has none. */
    QString sessionId;
    QString projectId;
    /** update|delete|copy|export-html */
    QString recordAction;
    /** stop|abort|restart|compact|state|commands|export-html|edit-message|… */
    QString runtimeAction;
};

/**
 * Match one request.
 *
 * `rawPath` is the still-encoded path (no query), `method` the verbatim request method.
 */
Match match(const QByteArray &method, const QByteArray &rawPath);

/** Query parameter with URLSearchParams semantics; false when absent. */
bool queryParameter(const QByteArray &query, const QString &name, QString *value);

} // namespace webroute
