#include "ClipboardController.h"
#include "FileDropController.h"
#include "HostRpcServer.h"
#include "NodeProcessController.h"
#include "StartupWindowBounds.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMimeData>
#include <QSize>
#include <QTcpSocket>
#include <QTimer>
#include <QUrl>
#include <QThread>

#include <cwchar>
#include <functional>
#include <iostream>
#include <memory>
#include <utility>
#include <vector>

namespace {
constexpr int kTimeoutMs = 2'000;

QByteArray frame(const QJsonObject &payload)
{
    const QByteArray body = QJsonDocument(payload).toJson(QJsonDocument::Compact);
    QByteArray packet(4, Qt::Uninitialized);
    const quint32 length = static_cast<quint32>(body.size());
    packet[0] = char(length & 0xff);
    packet[1] = char((length >> 8) & 0xff);
    packet[2] = char((length >> 16) & 0xff);
    packet[3] = char((length >> 24) & 0xff);
    packet.append(body);
    return packet;
}

class FrameClient final {
public:
    explicit FrameClient(quint16 port)
    {
        m_socket.connectToHost(QStringLiteral("127.0.0.1"), port);
    }

    bool connect(int timeoutMs = kTimeoutMs)
    {
        return m_socket.waitForConnected(timeoutMs);
    }

    void send(const QJsonObject &payload)
    {
        m_socket.write(frame(payload));
        m_socket.flush();
    }

    void sendOversizedHeader()
    {
        QByteArray packet(4, Qt::Uninitialized);
        const quint32 length = 32U * 1024U * 1024U + 1U;
        packet[0] = char(length & 0xff);
        packet[1] = char((length >> 8) & 0xff);
        packet[2] = char((length >> 16) & 0xff);
        packet[3] = char((length >> 24) & 0xff);
        m_socket.write(packet);
        m_socket.flush();
    }

    bool waitFor(const std::function<bool(const QJsonObject &)> &predicate,
                 QJsonObject *matched = nullptr, int timeoutMs = kTimeoutMs)
    {
        QElapsedTimer timer;
        timer.start();
        while (timer.elapsed() < timeoutMs) {
            QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
            readAvailable();
            for (qsizetype index = 0; index < m_frames.size(); ++index) {
                if (!predicate(m_frames.at(index))) continue;
                if (matched) *matched = m_frames.takeAt(index);
                else m_frames.removeAt(index);
                return true;
            }
            if (m_socket.state() == QAbstractSocket::UnconnectedState) {
                readAvailable();
                break;
            }
            QThread::msleep(1);
        }
        return false;
    }

    void disconnect()
    {
        m_socket.disconnectFromHost();
    }

    bool waitForDisconnected(int timeoutMs = kTimeoutMs)
    {
        QElapsedTimer timer;
        timer.start();
        while (timer.elapsed() < timeoutMs) {
            QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
            if (m_socket.state() == QAbstractSocket::UnconnectedState) return true;
            QThread::msleep(1);
        }
        return m_socket.state() == QAbstractSocket::UnconnectedState;
    }

private:
    void readAvailable()
    {
        m_buffer.append(m_socket.readAll());
        while (m_buffer.size() >= 4) {
            const auto *header = reinterpret_cast<const unsigned char *>(m_buffer.constData());
            const quint32 length = quint32(header[0])
                | (quint32(header[1]) << 8)
                | (quint32(header[2]) << 16)
                | (quint32(header[3]) << 24);
            if (m_buffer.size() < 4 + qsizetype(length)) return;
            const QByteArray body = m_buffer.mid(4, qsizetype(length));
            m_buffer.remove(0, 4 + qsizetype(length));
            const QJsonDocument document = QJsonDocument::fromJson(body);
            if (document.isObject()) m_frames.append(document.object());
        }
    }

    QTcpSocket m_socket;
    QByteArray m_buffer;
    QList<QJsonObject> m_frames;
};

bool require(bool condition, const char *message)
{
    if (condition) return true;
    std::cerr << message << std::endl;
    return false;
}
}

int main(int argc, char **argv)
{
    QCoreApplication application(argc, argv);
    QMimeData mimeData;
    mimeData.setUrls({QUrl::fromLocalFile(QStringLiteral("C:/one/same.txt")),
                      QUrl::fromLocalFile(QStringLiteral("D:/two/same.txt"))});
    const QJsonObject drop = FileDropController::payload(&mimeData, QPoint(12, 34));
    if (!require(drop.value(QStringLiteral("clientX")).toInt() == 12
                     && drop.value(QStringLiteral("clientY")).toInt() == 34,
                 "file drop client coordinates were not preserved")) return 1;
    if (!require(drop.value(QStringLiteral("paths")).toArray().size() == 2,
                 "file drop absolute paths were not preserved")) return 1;

    if (!require(startupWindowSize(QStringLiteral("normal-compact")) == QSize(1100, 720),
                 "compact startup window preset was not preserved")) return 1;
    if (!require(startupWindowSize(QStringLiteral("normal-medium")) == QSize(1280, 840),
                 "medium startup window preset was not preserved")) return 1;
    if (!require(startupWindowSize(QStringLiteral("normal-large")) == QSize(1480, 960),
                 "large startup window preset was not preserved")) return 1;
    if (!require(minimumWindowSizeForAvailable(QSize(640, 480)) == QSize(640, 480),
                 "window minimum exceeded a small available screen")) return 1;
    if (!require(minimumWindowSizeForAvailable(QSize(1920, 1080)) == QSize(880, 640),
                 "window minimum changed on a normal available screen")) return 1;

    const wchar_t clipboardPath[] = L"C:\\clipboard\\same.txt";
    if (!require(ClipboardController::decodeWindowsDropPath(
                     clipboardPath, static_cast<int>(wcslen(clipboardPath)))
                     == QStringLiteral("C:\\clipboard\\same.txt"),
                 "CF_HDROP path contained an unexpected terminator")) return 1;

    HostRpcServer server;
    if (!require(server.start(), "HostRpcServer failed to listen")) return 1;

    server.registerHandler(QStringLiteral("test.echo"), [](const QJsonObject &params) {
        return QJsonValue(params);
    });
    server.registerAsyncHandler(QStringLiteral("test.async"), [](const QJsonObject &params,
                                                                  HostRpcServer::AsyncResponder respond) {
        QTimer::singleShot(1, [params, respond = std::move(respond)] {
            respond(params, {});
        });
    });
    server.setEventHandler([](const QString &, const QJsonValue &) {});

    FrameClient active(server.port());
    if (!require(active.connect(), "authenticated client failed to connect")) return 1;
    active.send(QJsonObject{{QStringLiteral("type"), QStringLiteral("hello")},
                            {QStringLiteral("token"), server.token()}});
    QJsonObject hello;
    if (!require(active.waitFor([](const QJsonObject &value) {
        return value.value(QStringLiteral("type")).toString() == QStringLiteral("hello");
    }, &hello), "authenticated hello response missing")) return 1;
    if (!require(hello.value(QStringLiteral("ok")).toBool(), "valid token was rejected")) return 1;

    active.send(QJsonObject{{QStringLiteral("type"), QStringLiteral("request")},
                            {QStringLiteral("id"), QStringLiteral("async-response")},
                            {QStringLiteral("method"), QStringLiteral("test.async")},
                            {QStringLiteral("params"), QJsonObject{{QStringLiteral("value"), 7}}}});
    if (!require(active.waitFor([](const QJsonObject &value) {
        return value.value(QStringLiteral("type")).toString() == QStringLiteral("response")
            && value.value(QStringLiteral("id")).toString() == QStringLiteral("async-response")
            && value.value(QStringLiteral("result")).toObject().value(QStringLiteral("value")).toInt() == 7;
    }, nullptr), "asynchronous host response was not delivered")) return 1;

    active.send(QJsonObject{{QStringLiteral("type"), QStringLiteral("request")},
                            {QStringLiteral("id"), QStringLiteral("before-attack")},
                            {QStringLiteral("method"), QStringLiteral("test.echo")},
                            {QStringLiteral("params"), QJsonObject{{QStringLiteral("value"), 1}}}});
    if (!require(active.waitFor([](const QJsonObject &value) {
        return value.value(QStringLiteral("type")).toString() == QStringLiteral("response")
            && value.value(QStringLiteral("id")).toString() == QStringLiteral("before-attack")
            && value.value(QStringLiteral("ok")).toBool();
    }, nullptr), "authenticated request before candidate attack failed")) return 1;

    FrameClient candidate(server.port());
    if (!require(candidate.connect(), "candidate client failed to connect")) return 1;
    candidate.send(QJsonObject{{QStringLiteral("type"), QStringLiteral("hello")},
                               {QStringLiteral("token"), QStringLiteral("wrong-token")}});
    QJsonObject rejected;
    if (!require(candidate.waitFor([](const QJsonObject &value) {
        return value.value(QStringLiteral("type")).toString() == QStringLiteral("hello");
    }, &rejected), "invalid token response missing")) return 1;
    if (!require(!rejected.value(QStringLiteral("ok")).toBool(), "invalid token was accepted")) return 1;
    if (!require(candidate.waitForDisconnected(), "invalid candidate remained connected")) return 1;

    FrameClient pending(server.port());
    if (!require(pending.connect(), "pending authentication client failed to connect")) return 1;
    if (!require(pending.waitForDisconnected(6'000),
                 "unauthenticated client was not closed after the handshake timeout")) return 1;

    std::vector<std::unique_ptr<FrameClient>> pendingClients;
    for (int index = 0; index < 16; ++index) {
        pendingClients.push_back(std::make_unique<FrameClient>(server.port()));
        if (!require(pendingClients.back()->connect(), "authentication cap client failed to connect")) return 1;
    }
    FrameClient overflow(server.port());
    if (!require(overflow.connect(), "authentication overflow client failed to connect")) return 1;
    if (!require(overflow.waitForDisconnected(),
                 "authentication cap did not reject the overflow client")) return 1;
    for (const auto &client : pendingClients) {
        client->disconnect();
        if (!require(client->waitForDisconnected(),
                     "authentication cap client did not disconnect cleanly")) return 1;
    }

    FrameClient oversized(server.port());
    if (!require(oversized.connect(), "oversized-frame client failed to connect")) return 1;
    oversized.sendOversizedHeader();
    if (!require(oversized.waitForDisconnected(), "oversized frame was not rejected")) return 1;

    active.send(QJsonObject{{QStringLiteral("type"), QStringLiteral("request")},
                            {QStringLiteral("id"), QStringLiteral("after-attack")},
                            {QStringLiteral("method"), QStringLiteral("test.echo")},
                            {QStringLiteral("params"), QJsonObject{{QStringLiteral("value"), 2}}}});
    if (!require(active.waitFor([](const QJsonObject &value) {
        return value.value(QStringLiteral("type")).toString() == QStringLiteral("response")
            && value.value(QStringLiteral("id")).toString() == QStringLiteral("after-attack")
            && value.value(QStringLiteral("ok")).toBool();
    }, nullptr), "authenticated connection was displaced by invalid candidate")) return 1;

    server.sendEvent(QStringLiteral("test.event"), QJsonObject{{QStringLiteral("value"), 3}});
    if (!require(active.waitFor([](const QJsonObject &value) {
        return value.value(QStringLiteral("type")).toString() == QStringLiteral("event")
            && value.value(QStringLiteral("name")).toString() == QStringLiteral("test.event");
    }, nullptr), "event was not delivered to authenticated connection")) return 1;

    NativePaths processPaths;
    processPaths.nodeExecutable = qEnvironmentVariable("ComSpec", QStringLiteral("cmd.exe"));
    processPaths.nativeNodeEntry = QStringLiteral("/k");
    NodeProcessController processController(processPaths, &server);
    if (!require(processController.start(), "NodeProcessController test process failed to start")) return 1;
    int stopCallbacks = 0;
    processController.stopAsync([&stopCallbacks] { ++stopCallbacks; });
    processController.stopAsync([&stopCallbacks] { ++stopCallbacks; });
    QElapsedTimer stopTimer;
    stopTimer.start();
    while (stopCallbacks < 2 && stopTimer.elapsed() < 5'000) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 25);
        QThread::msleep(2);
    }
    if (!require(stopCallbacks == 2, "all asynchronous stop callbacks were not delivered")) return 1;
    if (!require(!processController.isRunning(), "stop callback fired before sidecar process exit")) return 1;

    FrameClient replacement(server.port());
    if (!require(replacement.connect(), "replacement client failed to connect")) return 1;
    replacement.send(QJsonObject{{QStringLiteral("type"), QStringLiteral("hello")},
                                 {QStringLiteral("token"), server.token()}});
    QJsonObject replacementHello;
    if (!require(replacement.waitFor([](const QJsonObject &value) {
        return value.value(QStringLiteral("type")).toString() == QStringLiteral("hello");
    }, &replacementHello), "replacement hello response missing")) return 1;
    if (!require(replacementHello.value(QStringLiteral("ok")).toBool(), "valid replacement token was rejected")) return 1;
    if (!require(active.waitForDisconnected(), "old authenticated connection was not replaced")) return 1;

    const QString backpressureChunk(256 * 1024, QLatin1Char('x'));
    for (int index = 0; index < 64; ++index) {
        server.sendEvent(QStringLiteral("test.backpressure"), QJsonObject{
            {QStringLiteral("index"), index},
            {QStringLiteral("chunk"), backpressureChunk},
        });
    }
    if (!require(replacement.waitForDisconnected(),
                 "host RPC peer that stopped reading exceeded the write budget without disconnecting")) return 1;

    return 0;
}
