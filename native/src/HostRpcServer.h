#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QHash>
#include <QTcpServer>
#include <QTcpSocket>

#include <functional>
#include <memory>

class HostRpcServer final : public QTcpServer {
public:
    using Handler = std::function<QJsonValue(const QJsonObject &params)>;
    using AsyncResponder = std::function<void(const QJsonValue &result, const QString &error)>;
    using AsyncHandler = std::function<void(const QJsonObject &params, AsyncResponder respond)>;
    using EventHandler = std::function<void(const QString &name, const QJsonValue &payload)>;

    explicit HostRpcServer(QObject *parent = nullptr);

    bool start();
    quint16 port() const;
    const QString &token() const;

    void registerHandler(const QString &method, Handler handler);
    void registerAsyncHandler(const QString &method, AsyncHandler handler);
    void setEventHandler(EventHandler handler);
    void sendEvent(const QString &name, const QJsonValue &payload = QJsonValue(QJsonValue::Null));

protected:
    void incomingConnection(qintptr socketDescriptor) override;

private:
    int unauthenticatedConnectionCount() const;
    void handleData(QTcpSocket *socket, const QByteArray &chunk);
    void handleFrame(QTcpSocket *socket, const QByteArray &payload);
    bool writeFrame(QTcpSocket *socket, const QJsonObject &frame);
    void sendResponse(QTcpSocket *socket, const QString &id, bool ok,
                      const QJsonValue &result = QJsonValue(QJsonValue::Undefined),
                      const QString &error = {});
    bool isTokenValid(const QString &candidate) const;

    struct ConnectionState {
        QByteArray receiveBuffer;
        bool authenticated = false;
    };

    QTcpSocket *m_activeSocket = nullptr;
    QHash<QTcpSocket *, ConnectionState> m_connections;
    QHash<QString, Handler> m_handlers;
    QHash<QString, AsyncHandler> m_asyncHandlers;
    EventHandler m_eventHandler;
    QString m_token;
};
