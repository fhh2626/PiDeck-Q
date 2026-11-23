#pragma once

#include <QJsonObject>
#include <QProcess>
#include <QString>
#include <QStringList>

class PiRpcClient {
public:
    bool start(const QString &program, const QStringList &arguments);
    QJsonObject request(const QJsonObject &command, int timeoutMs = 5000);
    void stop();
    bool running() const;
    /** Exposed so the owner can register the child for lifecycle cleanup. */
    QProcess *process() { return &m_process; }

private:
    QProcess m_process;
    QByteArray m_buffer;
};
