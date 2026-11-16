#pragma once

#include "NativePaths.h"

#include <QProcess>
#include <QObject>
#include <QTimer>
#include <QString>

#include <functional>
#include <vector>

class HostRpcServer;

class BackendProcessController final : public QObject {
public:
    using ExitHandler = std::function<void(int exitCode, QProcess::ExitStatus status)>;
    using ErrorHandler = std::function<void(const QString &message)>;
    using ReadyToExitHandler = std::function<void()>;
    using StopFinishedHandler = std::function<void()>;

    explicit BackendProcessController(const NativePaths &paths, HostRpcServer *host,
                                   QObject *parent = nullptr);
    ~BackendProcessController() override;

    bool start();
    /** Begin graceful shutdown without blocking the Qt event loop. */
    void stopAsync(StopFinishedHandler handler = {});
    /** Synchronous emergency cleanup used only by destruction/startup failure paths. */
    void stop();
    bool isRunning() const;
    QProcess *process();

    void setExitHandler(ExitHandler handler);
    void setErrorHandler(ErrorHandler handler);
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
    ExitHandler m_exitHandler;
    ErrorHandler m_errorHandler;
    ReadyToExitHandler m_readyToExitHandler;
    std::vector<StopFinishedHandler> m_stopFinishedHandlers;
    QTimer m_gracefulStopTimer;
    QTimer m_postAckStopTimer;
    bool m_readyToExit = false;
    bool m_stopRequested = false;
    bool m_asyncStopCompleted = false;
    // Stored as an opaque pointer so the header stays platform-neutral. On Windows
    // this is a HANDLE for the Job Object that owns the sidecar process tree.
    void *m_jobHandle = nullptr;
};
