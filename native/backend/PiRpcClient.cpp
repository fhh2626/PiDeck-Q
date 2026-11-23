#include "PiRpcClient.h"

#include "ChildEnvironment.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QUuid>

bool PiRpcClient::start(const QString &program, const QStringList &arguments)
{
    if (m_process.state() != QProcess::NotRunning) stop();
    m_buffer.clear();
    m_process.setProgram(program);
    m_process.setArguments(arguments);
    // pi and every tool it spawns must not inherit the host bridge credential.
    m_process.setProcessEnvironment(childenv::sanitized());
    m_process.start();
    return m_process.waitForStarted(5000);
}

QJsonObject PiRpcClient::request(const QJsonObject &command, int timeoutMs)
{
    QJsonObject payload = command;
    if (!payload.contains(QStringLiteral("id"))) payload.insert(QStringLiteral("id"), QUuid::createUuid().toString(QUuid::WithoutBraces));
    const QString id = payload.value(QStringLiteral("id")).toString();
    m_process.write(QJsonDocument(payload).toJson(QJsonDocument::Compact) + "\n");
    const qint64 deadline = QDateTime::currentMSecsSinceEpoch() + timeoutMs;
    while (QDateTime::currentMSecsSinceEpoch() < deadline) {
        if (!m_process.waitForReadyRead(50)) continue;
        m_buffer.append(m_process.readAllStandardOutput());
        while (true) {
            const int newline = m_buffer.indexOf('\n');
            if (newline < 0) break;
            const QByteArray line = m_buffer.left(newline);
            m_buffer.remove(0, newline + 1);
            const QJsonObject message = QJsonDocument::fromJson(line).object();
            if (message.value(QStringLiteral("id")).toString() == id) return message;
        }
    }
    return QJsonObject{{QStringLiteral("success"), false}, {QStringLiteral("error"), QStringLiteral("RPC command timed out")}};
}

void PiRpcClient::stop()
{
    if (m_process.state() == QProcess::NotRunning) return;
    m_process.terminate();
    if (!m_process.waitForFinished(1000)) m_process.kill();
    m_process.waitForFinished(1000);
}

bool PiRpcClient::running() const
{
    return m_process.state() != QProcess::NotRunning;
}
