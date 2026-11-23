#pragma once

#include <QByteArray>
#include <QString>
#include <QUrl>

#include <functional>

/**
 * Asynchronous HTTP GET for the remote catalogues.
 *
 * The store channels talk to prompts.chat and skills.sh. `QNetworkAccessManager` is
 * event-loop driven, so the request runs on the GUI thread and answers through a
 * callback: blocking the backend thread for a 15 s network call would stall the
 * renderer RPC, the SSE stream and the host bridge at the same time.
 *
 * Every call has a hard deadline and a bounded response body, because the endpoint is
 * untrusted input.
 */
namespace markethttp {

/** Largest response body accepted (a prompt catalogue page is far below this). */
constexpr qint64 kMaxBodyBytes = 8 * 1024 * 1024;

struct Response {
    int status = 0;
    QByteArray body;
    /** Transport-level failure (DNS, TLS, timeout, oversize). */
    QString error;

    bool ok() const { return error.isEmpty() && status >= 200 && status < 300; }
    /** The oracle's message shape: `prompts.chat API 返回 <status>`. */
    QString statusMessage(const QString &endpoint) const;
};

using Done = std::function<void(const Response &)>;

/** GET `url` and answer once, on the caller's thread. */
void get(const QUrl &url, int timeoutMs, Done done);

} // namespace markethttp
