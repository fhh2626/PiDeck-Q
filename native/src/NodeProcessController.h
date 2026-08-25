#pragma once

#include "NativePaths.h"

#include <QProcess>
#include <QObject>
#include <QTimer>
#include <QString>

#include <functional>

class HostRpcServer;

class NodeProcessController final : public QObject {
public:
    using NodeExitHandler = std::function<void(int exitCode, QProcess::ExitStatus status)>;
    using NodeErrorHandler = std::function<void(const QString &message)>;
    using ReadyToExitHandler = std::function<void()>;
    using StopFinishedHandler = std::function<void()>;

    explicit NodeProcessController(const NativePaths &paths, HostRpcServer *host,
                                   QObject *parent = nullptr);
    ~NodeProcessController() override;

    bool start();
    /** Begin graceful shutdown without blocking the Qt event loop. */
    void stopAsync(StopFinishedHandler handler = {});
    /** Synchronous emergency cleanup used only by destruction/startup failure paths. */
    void stop();
    bool isRunning() const;
    QProcess *process();

    void setNodeExitHandler(NodeExitHandler handler);
    void setNodeErrorHandler(NodeErrorHandler handler);
    void setReadyToExitHandler(ReadyToExitHandler handler);
    void markReadyToExit();

private:
#ifdef Q_OS_WIN
    bool createJobObject();
    bool assignProcessToJob();
    bool terminateJobObject();
    bool fallbackTerminateProcessTree();
    void closeJobObject();
#endif
    void completeAsyncStop();
    void forceStop();

    NativePaths m_paths;
    HostRpcServer *m_host = nullptr;
    QProcess m_process;
    NodeExitHandler m_nodeExitHandler;
    NodeErrorHandler m_nodeErrorHandler;
    ReadyToExitHandler m_readyToExitHandler;
    StopFinishedHandler m_stopFinishedHandler;
    QTimer m_gracefulStopTimer;
    QTimer m_postAckStopTimer;
    bool m_readyToExit = false;
    bool m_stopRequested = false;
    bool m_asyncStopCompleted = false;
    // Stored as an opaque pointer so the header stays platform-neutral. On Windows
    // this is a HANDLE for the Job Object that owns the sidecar process tree.
    void *m_jobHandle = nullptr;
};
