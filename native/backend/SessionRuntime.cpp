#include "SessionRuntime.h"

#include "ChildProcessRegistry.h"

SessionRuntimeResult SessionRuntime::activate(const QString &sessionId, const QString &program, const QStringList &arguments)
{
    m_client.stop();
    m_sessionId = sessionId;
    m_program = program;
    m_arguments = arguments;
    m_agentId = QStringLiteral("agent-%1").arg(++m_generation);
    SessionRuntimeResult result;
    result.runtimeGeneration = m_generation;
    if (!m_client.start(program, arguments)) {
        result.error = QStringLiteral("pi process failed to start");
        return result;
    }
    // Track the child so shutdown can stop it within a bounded window instead of
    // leaving pi alive for the host to force-kill.
    if (m_children) m_children->track(m_client.process(), QStringLiteral("pi"));
    const int generation = m_generation;
    const QJsonObject response = m_client.request(QJsonObject{{QStringLiteral("type"), QStringLiteral("get_state")}});
    if (generation != m_generation) {
        result.error = QStringLiteral("stale runtime generation");
        return result;
    }
    if (!response.value(QStringLiteral("success")).toBool()) {
        result.error = response.value(QStringLiteral("error")).toString();
        return result;
    }
    result.ok = true;
    result.agentId = m_agentId;
    result.state = response.value(QStringLiteral("data")).toObject();
    return result;
}

SessionRuntimeResult SessionRuntime::restart()
{
    if (m_program.isEmpty()) {
        SessionRuntimeResult result;
        result.error = QStringLiteral("runtime is not active");
        return result;
    }
    return activate(m_sessionId, m_program, m_arguments);
}

SessionRuntimeResult SessionRuntime::command(const QString &type, const QJsonObject &fields)
{
    SessionRuntimeResult result;
    result.runtimeGeneration = m_generation;
    result.agentId = m_agentId;
    if (!m_client.running()) {
        result.error = QStringLiteral("runtime is not active");
        return result;
    }
    const int generation = m_generation;
    QJsonObject request{{QStringLiteral("type"), type}};
    for (auto it = fields.begin(); it != fields.end(); ++it) request.insert(it.key(), it.value());
    const QJsonObject response = m_client.request(request);
    if (generation != m_generation) {
        result.error = QStringLiteral("stale runtime generation");
        return result;
    }
    if (!response.value(QStringLiteral("success")).toBool()) {
        result.error = response.value(QStringLiteral("error")).toString();
        return result;
    }
    result.ok = true;
    result.state = response.value(QStringLiteral("data")).toObject();
    return result;
}

SessionRuntimeResult SessionRuntime::prompt(const QString &message)
{
    return command(QStringLiteral("prompt"), QJsonObject{{QStringLiteral("message"), message}});
}

SessionRuntimeResult SessionRuntime::abort()
{
    return command(QStringLiteral("abort"), {});
}

SessionRuntimeResult SessionRuntime::call(const QString &type, const QJsonObject &fields)
{
    return command(type, fields);
}

bool SessionRuntime::active() const
{
    return m_client.running();
}

QString SessionRuntime::sessionId() const
{
    return m_sessionId;
}

QString SessionRuntime::agentId() const
{
    return m_agentId;
}

int SessionRuntime::generation() const
{
    return m_generation;
}

SessionRuntimeResult SessionRuntime::stop()
{
    m_client.stop();
    SessionRuntimeResult result;
    result.ok = true;
    result.runtimeGeneration = m_generation;
    result.agentId = m_agentId;
    return result;
}
