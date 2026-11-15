#pragma once

#include <QString>

#include <memory>

/**
 * OS-exclusive "this process owns the version" claim.
 *
 * Port of the claim half of `src/main/singleInstance.ts`. The lock file is metadata;
 * primary-ness has to come from a primitive whose lifetime *is* the process lifetime,
 * because a crashed primary must not make every later launch exit as secondary.
 *
 *  - Windows: a named mutex (`Global\` with a `Local\` fallback). The kernel destroys it
 *    when the last handle closes, and `ERROR_ALREADY_EXISTS` is an exact "another live
 *    process owns this version" answer. A named pipe cannot be used for this: Qt's
 *    `QLocalServer::listen()` happily creates an additional pipe instance under an
 *    existing name, so both processes would believe they are primary.
 *  - POSIX: `flock(LOCK_EX|LOCK_NB)` on a per-version `.claim` file, released by the
 *    kernel on process exit.
 */
namespace singleinstance {

class Claim {
public:
    ~Claim();

    /**
     * Take the claim for `version`.
     *
     * `secondary` is set when another live process already owns it; `error` is set only
     * for a genuine failure (permissions, unusable home). Exactly one of the three
     * outcomes happens: a held claim, `secondary`, or `error`.
     */
    static std::unique_ptr<Claim> acquire(const QString &version, const QString &userDataDir,
                                          bool *secondary, QString *error);

    /** Release the claim. Idempotent; also runs from the destructor. */
    void release();

    bool held() const;

private:
    Claim() = default;

#ifdef Q_OS_WIN
    void *m_handle = nullptr;
#else
    int m_descriptor = -1;
#endif
};

} // namespace singleinstance
