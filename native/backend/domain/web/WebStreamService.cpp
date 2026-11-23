#include "WebStreamService.h"

#include "RuntimeCoordinator.h"
#include "WebStreamConnection.h"
#include "WebStreamTools.h"

#include <QJsonArray>

#include <QTcpSocket>

#include <algorithm>
#include <limits>

namespace webstream {
namespace {

/** Defaults mirror the bounded reader/writer pair the oracle relies on the OS for. */
constexpr qint64 kDefaultMaxBufferedBytes = 4LL * 1024LL * 1024LL;
constexpr int kDefaultHeartbeatMs = 15'000;

/** Test seam for the backpressure cap; clamped so a typo cannot disable the guard. */
qint64 configuredBufferLimit()
{
    bool ok = false;
    const int raw = qEnvironmentVariableIntValue("PIDECK_WEB_STREAM_MAX_BUFFER_BYTES", &ok);
    if (!ok) return kDefaultMaxBufferedBytes;
    return std::clamp<qint64>(raw, 16LL * 1024LL, 64LL * 1024LL * 1024LL);
}

/** Test seam for the comment-frame interval (a real phone needs seconds, not minutes). */
int configuredHeartbeatMs()
{
    bool ok = false;
    const int raw = qEnvironmentVariableIntValue("PIDECK_WEB_STREAM_HEARTBEAT_MS", &ok);
    if (!ok) return kDefaultHeartbeatMs;
    return std::clamp(raw, 50, 300'000);
}

} // namespace

Service::Service(Deps deps, QObject *parent)
    : QObject(parent), m_deps(std::move(deps))
{
    m_router.setResolveSession([this](const QString &agentId) -> QString {
        if (!m_deps.coordinator) return QString();
        return m_deps.coordinator->sessionIdForAgent(agentId);
    });
}

Service::~Service()
{
    // Base-class destruction must not leave the coordinator holding a dangling callable.
    stop();
}

void Service::start()
{
    if (m_started || !m_deps.coordinator) return;
    runtime::Coordinator *coordinator = m_deps.coordinator;
    // Subscribe once, before any prompt can be dispatched: the POST path opens the
    // stream first, and a frame that arrives in between must not be lost.
    m_piObserver = coordinator->addPiEventObserver(
        [this](const QString &agentId, const QJsonObject &event, int streamGeneration) {
            m_router.onPiEvent(agentId, event, streamGeneration);
        });
    m_stateObserver = coordinator->addStateObserver([this] { observe(); });
    m_started = true;
}

void Service::stop()
{
    if (m_deps.coordinator) {
        if (m_piObserver) m_deps.coordinator->removeObserver(m_piObserver);
        if (m_stateObserver) m_deps.coordinator->removeObserver(m_stateObserver);
    }
    m_piObserver = 0;
    m_stateObserver = 0;
    if (!m_started && m_connections.isEmpty()) {
        m_router.clear();
        return;
    }
    m_started = false;
    m_router.clear();
    // Copy the ids: `abort()` closes the socket synchronously, and the connection's closed
    // handler erases its entry from m_connections, which would invalidate a live iterator.
    const QList<int> ids = m_connections.keys();
    for (int id : ids) {
        const auto iterator = m_connections.find(id);
        if (iterator == m_connections.end()) continue;
        const QPointer<WebStreamConnection> connection = iterator->connection;
        m_connections.erase(iterator);
        if (!connection) continue;
        // The service is dropping this socket on purpose: detach the callback so closing
        // it cannot re-enter dropConnection while the table is being cleared.
        connection->setClosedHandler(nullptr);
        connection->abort();
    }
    m_connections.clear();
}

bool Service::open(const QString &sessionId, QTcpSocket *socket, Admission admission,
                   bool replayTools)
{
    if (!socket || sessionId.isEmpty()) return false;
    if (!m_deps.coordinator) return false;

    // A GET reconnect can be the first subscriber after Web was enabled mid-tool: seed
    // the translator from the *matching* live runtime only (never a different session or
    // an older generation), and only with tool inputs.
    QVector<ToolInput> tools;
    if (replayTools) {
        tools = readCurrentToolInputs(sessionId,
                                      m_deps.coordinator->listRuntimes().toArray(),
                                      m_deps.coordinator->runtimeMessages(sessionId));
    }

    WebStreamConnection::Options options;
    options.maxBufferedBytes = configuredBufferLimit();
    options.heartbeatMs = configuredHeartbeatMs();
    auto *connection = new WebStreamConnection(socket, options, this);
    connection->setLogSink(m_deps.log);

    const int id = m_nextConnectionId++;
    // The socket may already be gone before the first frame (tab closed immediately).
    connection->setClosedHandler([this, id] { dropConnection(id); });

    Writer writer;
    const QPointer<WebStreamConnection> guarded(connection);
    writer.write = [guarded](const QString &wire) -> bool {
        return guarded && !guarded->closed() && guarded->writeRaw(wire);
    };
    writer.onClose = [guarded] {
        if (guarded) guarded->finish();
    };
    writer.onFinish = [guarded] {
        if (guarded) guarded->finish();
    };

    Entry entry;
    entry.connection = connection;
    entry.sessionId = sessionId;
    entry.subscriberToken = m_router.attach(sessionId, writer, tools, admission);
    m_connections.insert(id, entry);

    // Runtime admission is applied synchronously after subscribing: a settled event that
    // arrived before this check is visible as idle and finishes now; one that arrives
    // after is delivered to the registered subscriber. Awaiting here would reopen the race.
    //
    // A dispatch stream also owns a prompt that has not been acknowledged yet: while it is
    // pending the run must not be finished by an *idle* snapshot (the runtime is idle for a
    // moment before the prompt lands), otherwise a rejected dispatch would look like a
    // successful empty answer.
    if (admission == Admission::Dispatch) m_router.setPromptPending(sessionId, true);
    observe();
    return true;
}

void Service::promptDispatched(const QString &sessionId, const QString &errorText)
{
    m_router.setPromptPending(sessionId, false);
    if (!errorText.isEmpty()) {
        // The prompt never reached pi: close the run with an error frame instead of a
        // bare `finish` that the phone would render as an empty successful reply.
        m_router.finish(sessionId, errorText);
        return;
    }
    // Accepted: re-apply the runtime admission so a turn that already ended (very fast
    // reply) finishes now instead of waiting for the next snapshot.
    observe();
}

void Service::observe()
{
    if (!m_started || !m_deps.coordinator) return;
    m_router.observe(readRuntimeInfos(m_deps.coordinator->listRuntimes().toArray()));
}

void Service::dropConnection(int id)
{
    const auto iterator = m_connections.find(id);
    if (iterator == m_connections.end()) return;
    const Entry entry = iterator.value();
    m_connections.erase(iterator);
    // Only this socket is detached: the run keeps translating for a reconnect, exactly
    // like the oracle (translator state belongs to the run, not to the socket).
    if (entry.subscriberToken > 0) m_router.detach(entry.sessionId, entry.subscriberToken);
}

} // namespace webstream
