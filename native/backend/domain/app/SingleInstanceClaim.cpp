#include "app/SingleInstanceClaim.h"

#include "app/SingleInstancePaths.h"

#include <QDir>
#include <QFile>

#ifdef Q_OS_WIN
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace singleinstance {

Claim::~Claim()
{
    release();
}

void Claim::release()
{
#ifdef Q_OS_WIN
    if (m_handle) {
        CloseHandle(static_cast<HANDLE>(m_handle));
        m_handle = nullptr;
    }
#else
    if (m_descriptor >= 0) {
        ::flock(m_descriptor, LOCK_UN);
        ::close(m_descriptor);
        m_descriptor = -1;
    }
#endif
}

bool Claim::held() const
{
#ifdef Q_OS_WIN
    return m_handle != nullptr;
#else
    return m_descriptor >= 0;
#endif
}

std::unique_ptr<Claim> Claim::acquire(const QString &version, const QString &userDataDir, bool *secondary,
                                      QString *error)
{
    if (secondary) *secondary = false;
    std::unique_ptr<Claim> claim(new Claim());
#ifdef Q_OS_WIN
    const QString suffix = QStringLiteral("pideck-") + endpointDigest(userDataDir, version);
    // `Global\` matches the oracle's machine-wide pipe name: the same profile opened from a
    // second Windows session must forward instead of becoming a second primary. The digest
    // already contains the user data directory, so other users never collide. A process that
    // lacks SeCreateGlobalPrivilege falls back to the per-session namespace instead of
    // refusing to start — worst case two sessions both run, which is still better than none.
    const QString globalName = QStringLiteral("Global\\") + suffix;
    HANDLE handle = CreateMutexW(nullptr, FALSE,
                                 reinterpret_cast<const wchar_t *>(globalName.utf16()));
    if (!handle) {
        const QString localName = QStringLiteral("Local\\") + suffix;
        handle = CreateMutexW(nullptr, FALSE,
                              reinterpret_cast<const wchar_t *>(localName.utf16()));
    }
    if (!handle) {
        if (error) *error = QStringLiteral("Unable to create the single-instance mutex");
        return nullptr;
    }
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        // Another live process owns this version: the mutex disappears with its owner, so
        // this cannot be a stale claim from a crashed instance.
        CloseHandle(handle);
        if (secondary) *secondary = true;
        return nullptr;
    }
    claim->m_handle = handle;
#else
    QDir().mkpath(locksDirectory(userDataDir));
    const QByteArray encoded = QFile::encodeName(claimPathFor(userDataDir, version));
    const int descriptor = ::open(encoded.constData(), O_RDWR | O_CREAT, 0600);
    if (descriptor < 0) {
        if (error) *error = QStringLiteral("Unable to open the single-instance claim file");
        return nullptr;
    }
    if (::flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
        ::close(descriptor);
        if (errno == EWOULDBLOCK) {
            if (secondary) *secondary = true;
            return nullptr;
        }
        if (error) *error = QStringLiteral("Unable to lock the single-instance claim file");
        return nullptr;
    }
    claim->m_descriptor = descriptor;
#endif
    return claim;
}

} // namespace singleinstance
