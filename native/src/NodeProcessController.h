#pragma once

#include "NativePaths.h"

#include <QProcess>
#include <QObject>
#include <QString>

class HostRpcServer;

class NodeProcessController final : public QObject {
public:
    explicit NodeProcessController(const NativePaths &paths, HostRpcServer *host,
                                   QObject *parent = nullptr);
    ~NodeProcessController() override;

    bool start();
    void stop();
    bool isRunning() const;
    QProcess *process();

private:
#ifdef Q_OS_WIN
    bool createJobObject();
    bool assignProcessToJob();
    bool terminateJobObject();
    bool fallbackTerminateProcessTree();
    void closeJobObject();
#endif

    NativePaths m_paths;
    HostRpcServer *m_host = nullptr;
    QProcess m_process;
    // Stored as an opaque pointer so the header stays platform-neutral. On Windows
    // this is a HANDLE for the Job Object that owns the sidecar process tree.
    void *m_jobHandle = nullptr;
};
