#include "HttpClient.h"

#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPointer>
#include <QTimer>

namespace markethttp {
namespace {

/**
 * One manager for the process. `QNetworkAccessManager` keeps its own connection pool,
 * so a per-request instance would throw away keep-alive on every search.
 */
QNetworkAccessManager *manager()
{
    static QNetworkAccessManager *instance = new QNetworkAccessManager();
    return instance;
}

} // namespace

QString Response::statusMessage(const QString &endpoint) const
{
    return QStringLiteral("%1 API returned %2").arg(endpoint).arg(status);
}

void get(const QUrl &url, int timeoutMs, Done done)
{
    if (!url.isValid() || url.scheme().isEmpty()) {
        Response response;
        response.error = QStringLiteral("Invalid request URL");
        done(response);
        return;
    }
    QNetworkRequest request(url);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::NoLessSafeRedirectPolicy);
    request.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("PiDeck-Q"));
    request.setTransferTimeout(timeoutMs);

    QNetworkReply *reply = manager()->get(request);
    // The callback may outlive the caller's stack frame, so it is invoked exactly once
    // through a shared guard instead of relying on the reply's lifetime.
    auto settled = std::make_shared<bool>(false);
    auto finish = [settled, done](const Response &response) {
        if (*settled) return;
        *settled = true;
        done(response);
    };

    QObject::connect(reply, &QNetworkReply::finished, reply, [reply, finish]() {
        Response response;
        response.status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        response.body = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            response.error = reply->errorString();
        } else if (response.body.size() > kMaxBodyBytes) {
            response.error = QStringLiteral("Response exceeded the size limit");
        }
        finish(response);
        reply->deleteLater();
    });
    QObject::connect(reply, &QNetworkReply::sslErrors, reply,
                     [reply](const QList<QSslError> &) { reply->abort(); });
}

} // namespace markethttp
