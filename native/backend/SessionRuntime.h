#pragma once

#include "PiRpcClient.h"

#include <QJsonObject>
#include <QString>
#include <QStringList>

class ChildProcessRegistry;

struct SessionRuntimeResult {
    bool ok = false;
    int runtimeGeneration = 0;
    QString agentId;
    QString error;
    QJsonObject state;
};

class SessionRuntime {
public:
    SessionRuntimeResult activate(const QString &sessionId, const QString &program, const QStringList &arguments);
    SessionRuntimeResult restart();
    SessionRuntimeResult stop();
    SessionRuntimeResult prompt(const QString &message);
    SessionRuntimeResult abort();
    SessionRuntimeResult call(const QString &type, const QJsonObject &fields);
    bool active() const;
    QString sessionId() const;
    QString agentId() const;
    int generation() const;
    /** Register every spawned pi process for bounded shutdown cleanup. */
    void setChildRegistry(ChildProcessRegistry *registry) { m_children = registry; }

private:
    SessionRuntimeResult command(const QString &type, const QJsonObject &fields);
    PiRpcClient m_client;
    ChildProcessRegistry *m_children = nullptr;
    QString m_sessionId;
    QString m_program;
    QStringList m_arguments;
    QString m_agentId;
    int m_generation = 0;
};
