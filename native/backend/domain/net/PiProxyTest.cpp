#include "PiProxyTest.h"

#include <QAbstractSocket>
#include <QDateTime>
#include <QRegularExpression>
#include <QSslSocket>
#include <QTimer>
#include <QUrl>

#include <memory>

namespace pipproxytest {
namespace {

constexpr int kTimeoutMs = 8'000;
/** Node compares `buffer.length > 64 * 1024` after every chunk. */
constexpr qint64 kMaxHeadBytes = 64 * 1024;

/** `normalizeProxyUrl`: add `http://` when the user typed a bare `host:port`. */
QString normalizeProxyUrl(const QString &value)
{
    static const QRegularExpression schemePattern(QStringLiteral("^[a-z][a-z\\d+.-]*://"),
                                                  QRegularExpression::CaseInsensitiveOption);
    return schemePattern.match(value).hasMatch() ? value : QStringLiteral("http://") + value;
}

/** `getUrlPort`: explicit port, else the protocol default. */
int urlPort(const QUrl &url)
{
    if (url.port() > 0) return url.port();
    return url.scheme().compare(QStringLiteral("https"), Qt::CaseInsensitive) == 0 ? 443 : 80;
}

/** WHATWG `URL.host`: hostname plus the port only when it is not the scheme default. */
QString hostHeader(const QUrl &url)
{
    const QString host = url.host();
    const QString bracketed =
        host.contains(QLatin1Char(':')) ? QLatin1Char('[') + host + QLatin1Char(']') : host;
    const int defaultPort =
        url.scheme().compare(QStringLiteral("https"), Qt::CaseInsensitive) == 0 ? 443 : 80;
    if (url.port() <= 0 || url.port() == defaultPort) return bracketed;
    return bracketed + QLatin1Char(':') + QString::number(url.port());
}

/** WHATWG `URL.href` for the absolute-URI request line (empty path becomes `/`). */
QString absoluteHref(const QUrl &url)
{
    QUrl href = url;
    if (href.path().isEmpty()) href.setPath(QStringLiteral("/"));
    return QString::fromUtf8(href.toEncoded(QUrl::FullyEncoded));
}

/** `getRequestPath`: origin-form path plus query. */
QString requestPath(const QUrl &url)
{
    QString path = url.path();
    if (path.isEmpty()) path = QStringLiteral("/");
    const QString query = url.query(QUrl::FullyEncoded);
    return query.isEmpty() ? path : path + QLatin1Char('?') + query;
}

/** `proxyAuthHeader`: empty when the proxy URL carries no username. */
QByteArray proxyAuthHeader(const QUrl &proxy)
{
    if (proxy.userName().isEmpty()) return QByteArray();
    const QByteArray credentials =
        (proxy.userName() + QLatin1Char(':') + proxy.password()).toUtf8().toBase64();
    return "Proxy-Authorization: Basic " + credentials + "\r\n";
}

QByteArray buildProxyGetRequest(const QUrl &target, const QUrl &proxy)
{
    return ("GET " + absoluteHref(target) + " HTTP/1.1\r\n"
            + "Host: " + hostHeader(target) + "\r\n"
            + "User-Agent: pi-desktop-proxy-test\r\n"
            + proxyAuthHeader(proxy)
            + "Connection: close\r\n"
            + "\r\n").toUtf8();
}

QByteArray buildConnectRequest(const QUrl &target, const QUrl &proxy)
{
    const QString host = target.host();
    const QString authority =
        (host.contains(QLatin1Char(':')) ? QLatin1Char('[') + host + QLatin1Char(']') : host)
        + QLatin1Char(':') + QString::number(urlPort(target));
    return ("CONNECT " + authority + " HTTP/1.1\r\n"
            + "Host: " + authority + "\r\n"
            + "Proxy-Connection: Keep-Alive\r\n"
            + proxyAuthHeader(proxy)
            + "\r\n").toUtf8();
}

QByteArray buildOriginGetRequest(const QUrl &target)
{
    return ("GET " + requestPath(target) + " HTTP/1.1\r\n"
            + "Host: " + hostHeader(target) + "\r\n"
            + "User-Agent: pi-desktop-proxy-test\r\n"
            + "Connection: close\r\n"
            + "\r\n").toUtf8();
}

/** `parseStatusLine`: `HTTP/1.1 204 No Content` -> 204; anything else is invalid. */
int parseStatusLine(const QByteArray &line, bool *ok)
{
    static const QRegularExpression pattern(QStringLiteral("^HTTP/\\d(?:\\.\\d)?\\s+(\\d{3})\\b"));
    const QRegularExpressionMatch match = pattern.match(QString::fromLatin1(line));
    *ok = match.hasMatch();
    return *ok ? match.captured(1).toInt() : 0;
}

/**
 * One probe run: owns the socket, the phase timer and the single completion.
 *
 * The sequence is the oracle's: connect to the proxy (TLS first for an `https://`
 * proxy), then either an absolute-URI GET (http target) or CONNECT + TLS + origin-form
 * GET (https target). Every phase is guarded by the same 8 s budget.
 */
class Job : public QObject, public std::enable_shared_from_this<Job> {
public:
    Job(Settings settings, QString testUrl, maincopy::Translator translate, Done done)
        : m_settings(std::move(settings))
        , m_testUrl(std::move(testUrl))
        , m_translate(std::move(translate))
        , m_done(std::move(done))
        , m_startedAt(QDateTime::currentMSecsSinceEpoch())
    {
    }

    void start(const std::shared_ptr<Job> &self)
    {
        m_target = QUrl(m_testUrl);
        if (!m_target.isValid() || m_target.host().isEmpty()) {
            return fail(self, QStringLiteral("mainProxy.invalidUrl"));
        }
        if (!m_settings.enabled) return fail(self, QStringLiteral("mainProxy.enableFirst"));
        const QString proxyValue = m_settings.url.trimmed();
        if (proxyValue.isEmpty()) return fail(self, QStringLiteral("mainProxy.addressRequired"));
        if (matchesNoProxy(m_target.host(), urlPort(m_target), m_settings.bypass)) {
            const QString copy = m_translate
                ? m_translate(QStringLiteral("mainProxy.bypassed"), QJsonObject{})
                : QStringLiteral("mainProxy.bypassed");
            QJsonObject result = failure(copy);
            result.insert(QStringLiteral("bypassed"), true);
            return settle(self, result);
        }

        m_proxy = QUrl(normalizeProxyUrl(proxyValue), QUrl::StrictMode);
        if (!m_proxy.isValid() || m_proxy.host().isEmpty()) {
            return fail(self, QStringLiteral("mainProxy.invalidUrl"));
        }
        const QString proxyScheme = m_proxy.scheme().toLower();
        if (proxyScheme != QLatin1String("http") && proxyScheme != QLatin1String("https")) {
            return fail(self, QStringLiteral("mainProxy.proxyProtocolUnsupported"));
        }
        const QString targetScheme = m_target.scheme().toLower();
        if (targetScheme != QLatin1String("http") && targetScheme != QLatin1String("https")) {
            return fail(self, QStringLiteral("mainProxy.targetProtocolUnsupported"));
        }
        connectProxy(self);
    }

private:
    /** Next step after an HTTP head arrives. */
    enum class AfterHead { Finish, Tunnel };

    void connectProxy(const std::shared_ptr<Job> &self)
    {
        m_socket = new QSslSocket(this);
        wireSocket(self);
        const bool secureProxy =
            m_proxy.scheme().compare(QStringLiteral("https"), Qt::CaseInsensitive) == 0;
        if (secureProxy) {
            m_socket->setPeerVerifyName(m_proxy.host());
            startPhase(QStringLiteral("mainProxy.connectTimeout"));
            QObject::connect(m_socket, &QSslSocket::encrypted, this, [self] {
                self->stopPhase();
                self->afterProxyConnected(self);
            });
            m_socket->connectToHostEncrypted(m_proxy.host(), quint16(urlPort(m_proxy)));
            return;
        }
        startPhase(QStringLiteral("mainProxy.connectTimeout"));
        QObject::connect(m_socket, &QSslSocket::connected, this, [self] {
            self->stopPhase();
            self->afterProxyConnected(self);
        });
        m_socket->connectToHost(m_proxy.host(), quint16(urlPort(m_proxy)));
    }

    void afterProxyConnected(const std::shared_ptr<Job> &self)
    {
        if (*m_settledFlag || !m_socket) return;
        const bool httpTarget =
            m_target.scheme().compare(QStringLiteral("http"), Qt::CaseInsensitive) == 0;
        // Arm the read state before writing: a local stub can answer inside the same
        // event-loop iteration.
        m_afterHead = httpTarget ? AfterHead::Finish : AfterHead::Tunnel;
        m_head.clear();
        m_headDone = false;
        m_socket->write(httpTarget ? buildProxyGetRequest(m_target, m_proxy)
                                   : buildConnectRequest(m_target, m_proxy));
        startPhase(QStringLiteral("mainProxy.responseTimeout"));
        consumeBuffered(self);
    }

    /** Feed already-buffered bytes through the same path as `readyRead`. */
    void consumeBuffered(const std::shared_ptr<Job> &self)
    {
        if (*m_settledFlag || !m_socket || m_headDone) return;
        if (m_socket->bytesAvailable() <= 0) return;
        onData(self, m_socket->readAll());
    }

    void onData(const std::shared_ptr<Job> &self, const QByteArray &chunk)
    {
        if (*m_settledFlag || m_headDone) return;
        m_head += chunk;
        if (m_head.size() > kMaxHeadBytes) {
            return fail(self, QStringLiteral("mainProxy.headerTooLarge"));
        }
        if (m_head.contains("\r\n\r\n")) consumeHead(self);
    }

    void consumeHead(const std::shared_ptr<Job> &self)
    {
        if (*m_settledFlag || m_headDone) return;
        m_headDone = true;
        const int lineEnd = m_head.indexOf("\r\n");
        bool ok = false;
        const int status =
            parseStatusLine(m_head.left(lineEnd < 0 ? m_head.size() : lineEnd), &ok);
        if (!ok) return fail(self, QStringLiteral("mainProxy.invalidResponse"));
        stopPhase();
        if (m_afterHead == AfterHead::Finish) return succeed(self, status);
        if (status != 200) {
            return fail(self, QStringLiteral("mainProxy.connectStatus"),
                        QJsonObject{{QStringLiteral("status"), status}});
        }
        upgradeToTls(self);
    }

    void upgradeToTls(const std::shared_ptr<Job> &self)
    {
        if (*m_settledFlag || !m_socket) return;
        m_head.clear();
        m_headDone = false;
        m_afterHead = AfterHead::Finish;
        m_socket->setPeerVerifyName(m_target.host());
        startPhase(QStringLiteral("mainProxy.tlsTimeout"));
        QObject::connect(m_socket, &QSslSocket::encrypted, this, [self] {
            if (*self->m_settledFlag || !self->m_socket) return;
            self->stopPhase();
            self->m_head.clear();
            self->m_headDone = false;
            self->m_afterHead = AfterHead::Finish;
            self->m_socket->write(buildOriginGetRequest(self->m_target));
            self->startPhase(QStringLiteral("mainProxy.responseTimeout"));
            self->consumeBuffered(self);
        });
        // `startClientEncryption` turns the established plain socket into a TLS one;
        // the CONNECT head above is the only thing already sent to the proxy.
        m_socket->startClientEncryption();
    }

    void wireSocket(const std::shared_ptr<Job> &self)
    {
        QObject::connect(m_socket, &QSslSocket::readyRead, this,
                         [self] { self->consumeBuffered(self); });
        QObject::connect(m_socket, &QAbstractSocket::disconnected, this, [self] {
            if (*self->m_settledFlag || self->m_headDone) return;
            // A peer close before a full head is `closedEarly`; a half answer is never
            // treated as success.
            self->fail(self, QStringLiteral("mainProxy.closedEarly"));
        });
        QObject::connect(m_socket, &QAbstractSocket::errorOccurred, this,
                         [self](QAbstractSocket::SocketError error) {
                             if (*self->m_settledFlag) return;
                             self->fail(self, self->socketFailureKey(error));
                         });
    }

    /**
     * Map a socket error onto the oracle's copy.
     *
     * Node classifies by error-code string; Qt exposes the same classes through
     * `SocketError`. A TLS failure matches none of the oracle's named network errors,
     * so it degrades to `unknownError` exactly like Node's fallback branch.
     *
     * `mainProxy.connectionReset` is the one copy key this side never emits: Qt reports a
     * reset and an orderly FIN-close through the same `RemoteHostClosedError`, and the
     * oracle's own `end` path already calls that `closedEarly`. Guessing a reset would
     * mislabel the common FIN case, so the key is ported for table parity but stays
     * unused (documented in the backend plan's proxy record).
     */
    QString socketFailureKey(QAbstractSocket::SocketError error) const
    {
        switch (error) {
        case QAbstractSocket::ConnectionRefusedError:
            return QStringLiteral("mainProxy.connectionRefused");
        case QAbstractSocket::HostNotFoundError:
            return QStringLiteral("mainProxy.hostNotFound");
        case QAbstractSocket::RemoteHostClosedError:
            return QStringLiteral("mainProxy.closedEarly");
        case QAbstractSocket::SocketTimeoutError:
        case QAbstractSocket::NetworkError:
        case QAbstractSocket::ProxyConnectionTimeoutError:
            return QStringLiteral("mainProxy.connectionTimeout");
        default:
            return QStringLiteral("mainProxy.unknownError");
        }
    }

    void startPhase(const QString &key)
    {
        m_phaseKey = key;
        if (!m_phaseTimer) {
            m_phaseTimer = new QTimer(this);
            m_phaseTimer->setSingleShot(true);
            // The timer is reused across phases, so the key is read when it fires
            // instead of being captured once (connect -> TLS -> response).
            std::weak_ptr<Job> weak = weak_from_this();
            QObject::connect(m_phaseTimer, &QTimer::timeout, this, [weak] {
                if (const std::shared_ptr<Job> job = weak.lock()) job->fail(job, job->m_phaseKey);
            });
        }
        m_phaseTimer->start(kTimeoutMs);
    }

    void stopPhase()
    {
        if (m_phaseTimer) m_phaseTimer->stop();
    }

    qint64 elapsedMs() const { return QDateTime::currentMSecsSinceEpoch() - m_startedAt; }

    QJsonObject failure(const QString &copy) const
    {
        QJsonObject result{{QStringLiteral("success"), false},
                           {QStringLiteral("url"), m_testUrl},
                           {QStringLiteral("error"), copy}};
        result.insert(QStringLiteral("elapsedMs"), double(elapsedMs()));
        return result;
    }

    void fail(const std::shared_ptr<Job> &self, const QString &key,
              const QJsonObject &params = QJsonObject{})
    {
        if (*m_settledFlag) return;
        const QString copy = m_translate ? m_translate(key, params) : key;
        settle(self, failure(copy));
    }

    void succeed(const std::shared_ptr<Job> &self, int status)
    {
        if (*m_settledFlag) return;
        const QString copy =
            m_translate
                ? m_translate(QStringLiteral("mainProxy.success"),
                              QJsonObject{{QStringLiteral("status"), status}})
                : QString();
        QJsonObject result{{QStringLiteral("success"), true},
                           {QStringLiteral("url"), m_testUrl},
                           {QStringLiteral("statusCode"), status},
                           {QStringLiteral("message"), copy}};
        result.insert(QStringLiteral("elapsedMs"), double(elapsedMs()));
        settle(self, result);
    }

    void settle(const std::shared_ptr<Job> &self, const QJsonObject &result)
    {
        if (*m_settledFlag) return;
        *m_settledFlag = true;
        stopPhase();
        // Completion always arrives from inside a socket or timer signal, and the Job is
        // owned by `shared_ptr`: its last strong reference is the emitting connection's
        // own capture, released when the emission ends. A QObject child would then be
        // destroyed *inside* its own signal emission; QIODevice keeps touching itself
        // after emitting `errorOccurred`, so a parented socket turned the
        // close-before-head path (proxy answers a partial head, then FIN) into an access
        // violation. Detach both helpers and let the event loop delete them.
        detachSocket();
        if (m_phaseTimer) {
            m_phaseTimer->setParent(nullptr);
            m_phaseTimer->deleteLater();
            m_phaseTimer = nullptr;
        }
        Done done = std::move(m_done);
        // No `deleteLater` on the Job: the `shared_ptr` owns it, and Qt deleting an object
        // the smart pointer still holds would be a double free. The connection capture is
        // released as soon as the emission finishes, which is when this Job dies.
        Q_UNUSED(self);
        if (done) done(result);
    }

    /** Drop the live socket without destroying it from inside its own signal. */
    void detachSocket()
    {
        if (!m_socket) return;
        m_socket->disconnect(this);
        m_socket->setParent(nullptr);
        m_socket->deleteLater();
        m_socket = nullptr;
    }

    Settings m_settings;
    QString m_testUrl;
    maincopy::Translator m_translate;
    Done m_done;
    qint64 m_startedAt = 0;

    QUrl m_target;
    QUrl m_proxy;
    QSslSocket *m_socket = nullptr;
    QTimer *m_phaseTimer = nullptr;
    QString m_phaseKey;
    QByteArray m_head;
    bool m_headDone = false;
    AfterHead m_afterHead = AfterHead::Finish;
    std::shared_ptr<bool> m_settledFlag = std::make_shared<bool>(false);
};

} // namespace

Settings readSettings(const QJsonObject &settings)
{
    Settings parsed;
    parsed.enabled = settings.value(QStringLiteral("piProxyEnabled")).toBool(false);
    parsed.url = settings.value(QStringLiteral("piProxyUrl")).toString();
    parsed.bypass = settings.value(QStringLiteral("piProxyBypass")).toString();
    return parsed;
}

QString defaultTestUrl()
{
    return QStringLiteral("https://api.openai.com/v1/models");
}

bool matchesNoProxy(const QString &hostname, int port, const QString &bypass)
{
    const QString host = hostname.toLower();
    for (const QString &raw : bypass.split(QLatin1Char(','))) {
        const QString entry = raw.trimmed().toLower();
        if (entry.isEmpty()) continue;
        if (entry == QLatin1String("*")) return true;
        // `splitNoProxyPort`: the last colon starts a port unless the entry is IPv6.
        QString pattern = entry;
        QString entryPort;
        const int lastColon = entry.lastIndexOf(QLatin1Char(':'));
        if (lastColon > 0 && !entry.contains(QLatin1String("::"))) {
            pattern = entry.left(lastColon);
            entryPort = entry.mid(lastColon + 1);
        }
        if (!entryPort.isEmpty() && entryPort != QString::number(port)) continue;
        if (pattern.startsWith(QLatin1String("*."))) {
            if (host.endsWith(pattern.mid(1))) return true;
            continue;
        }
        if (pattern.startsWith(QLatin1Char('.'))) {
            if (host == pattern.mid(1) || host.endsWith(pattern)) return true;
            continue;
        }
        if (host == pattern || host.endsWith(QLatin1Char('.') + pattern)) return true;
    }
    return false;
}

void test(const Settings &settings, const QString &testUrl, const maincopy::Translator &translate,
          Done done)
{
    auto job = std::make_shared<Job>(settings, testUrl, translate, std::move(done));
    job->start(job);
}

} // namespace pipproxytest
