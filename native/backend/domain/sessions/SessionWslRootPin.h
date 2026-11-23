#pragma once

#include "SessionFs.h"
#include <QProcess>

namespace sessiondelete {

/** Keeps the original Linux root inode alive from planning through every trash batch. */
class WslRootPin {
public:
    WslRootPin(const SessionFs::Config &config, const QString &physicalRoot);
    ~WslRootPin();
    WslRootPin(const WslRootPin &) = delete;
    WslRootPin &operator=(const WslRootPin &) = delete;
    QString identity() const { return m_identity; }
    QString pid() const { return m_pid; }
    QString startTime() const { return m_startTime; }
private:
    void stop();
    QProcess m_process;
    QString m_identity;
    QString m_pid;
    QString m_startTime;
};

} // namespace sessiondelete
