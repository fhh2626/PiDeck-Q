#pragma once

#include "WebStreamAdapter.h"
#include "WebStreamRuntime.h"

#include <QHash>
#include <QJsonObject>
#include <QSet>
#include <QString>
#include <QVector>

#include <functional>
#include <memory>

/**
 * Session/run-scoped SSE router.
 *
 * Port of `WebEventStreamRouter` (src/main/web/WebEventStream.ts). The translator belongs
 * to a session run, not to a socket: a phone that drops the connection and reconnects
 * must not lose its reasoning block, its message step or its active tool calls. A socket
 * is only a subscriber that can attach/detach at any time.
 */
namespace webstream {

/** One attached socket. */
struct Writer {
    /** Write raw SSE text; false means the connection is gone (`onClose` follows). */
    std::function<bool(const QString &wire)> write;
    /** Close the response after this subscriber was dropped. */
    std::function<void()> onClose;
    /** The run finished for this socket (`finish` + `[DONE]` were written). */
    std::function<void()> onFinish;
};

class Router {
public:
    using ResolveSession = std::function<QString(const QString &agentId)>;

    void setResolveSession(ResolveSession resolve) { m_resolveSession = std::move(resolve); }

    /**
     * Attach one socket to a session's run (created on demand).
     *
     * `tools` seeds a cold translator from a matching live runtime (GET reconnect only);
     * `admission` decides whether an idle session finishes now or waits for a prompt.
     * Returns the subscriber token for `detach`.
     */
    int attach(const QString &sessionId, Writer writer, const QVector<ToolInput> &tools,
               Admission admission);

    /** Detach exactly this socket; the run keeps consuming pi events for other readers. */
    void detach(const QString &sessionId, int token);

    /** Drop every run and subscriber (service stop). Sockets are closed by the caller. */
    void clear();

    /** Follow/finish runs after a runtime snapshot change. */
    void observe(const QVector<RuntimeInfo> &runtimes);

    /** Finish a session's run; `errorText` non-empty produces an `error` frame. */
    void finish(const QString &sessionId, const QString &errorText = QString());

    /** Route one raw pi event into its session's run. */
    void onPiEvent(const QString &agentId, const QJsonObject &event, int streamGeneration);

    /**
     * Mark/unmark a run as waiting for its dispatch prompt acknowledgement.
     *
     * While pending, an idle runtime snapshot must not finish the run: that idle state is
     * the moment right before the prompt lands, not the end of an answer.
     */
    void setPromptPending(const QString &sessionId, bool pending);

    int runCount() const { return int(m_runs.size()); }

private:
    struct Subscriber {
        Writer writer;
        bool closed = false;
        /** Each socket's AI SDK parser has its own active-part table. */
        QSet<QString> openTextIds;
        QSet<QString> openReasoningIds;
    };

    struct Run {
        Adapter adapter;
        bool hasStreamGeneration = false;
        int streamGeneration = 0;
        bool hasTarget = false;
        Target runtimeTarget;
        /**
         * Run-level admission mode, sticky to `dispatch` once a POST subscribed.
         *
         * `Admission::Observe` is also the "not set yet" value: a fresh run created by a
         * GET stays observe, and a later POST upgrades it permanently.
         */
        Admission admission = Admission::Observe;
        /** A POST prompt that pi has not acknowledged yet (see `setPromptPending`). */
        bool promptPending = false;
        QHash<int, std::shared_ptr<Subscriber>> subscribers;
        int nextSubscriberId = 1;
    };

    std::shared_ptr<Run> getOrCreateRun(const QString &sessionId);
    void broadcast(Run &run, const QVector<QJsonObject> &frames);
    bool writeFrame(Subscriber &subscriber, const QJsonObject &frame);
    void closeSubscriber(Run &run, int token);

    ResolveSession m_resolveSession;
    QHash<QString, std::shared_ptr<Run>> m_runs;
};

} // namespace webstream
