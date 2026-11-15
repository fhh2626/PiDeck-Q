#pragma once

#include "SessionCommand.h"

#include <QString>
#include <QStringList>

/**
 * Session storage adapter: native filesystem or WSL through `wsl.exe`.
 *
 * The scanner, archive store and delete path all operate on one session tree, and the
 * tree may live inside a WSL distribution. Rather than sprinkling `if (wsl)` through
 * every call site (the prototype's approach, which silently mishandled every WSL
 * record), all path and IO differences live behind this interface.
 *
 * WSL commands are always argument arrays — never an interpolated shell string — and
 * run with a sanitized environment, so a path containing spaces or `$(...)` cannot
 * become a command.
 */
class SessionFs {
public:
    struct Config {
        bool wsl = false;
        QString distro;
        QString user;
        /** Linux home inside the distribution (`/home/<user>`). */
        QString home;
        /**
         * `wsl.exe` override (the `PIDECK_WSL_EXE` fixture seam). Empty means the
         * production resolution in `wsl::executableFor`.
         */
        QString executable;
    };

    explicit SessionFs(Config config = {});

    bool wsl() const { return m_config.wsl; }
    const Config &config() const { return m_config; }
    QString home() const { return m_config.home; }

    /** Path joining that follows the target platform's separator rules. */
    QString join(const QString &base, const QString &name) const;
    QString dirname(const QString &path) const;
    QString basename(const QString &path) const;
    /** File name without the trailing `.jsonl` (or the whole name). */
    QString stem(const QString &path) const;

    bool exists(const QString &path) const;
    bool isFile(const QString &path) const;
    bool isDirectory(const QString &path) const;
    QStringList listNames(const QString &directory) const;

    bool readText(const QString &path, QString *content, QString *error) const;
    bool readHead(const QString &path, qint64 maxBytes, QString *content, QString *error) const;
    bool writeAtomic(const QString &path, const QString &content, QString *error) const;
    /** Move that refuses to clobber (used by archive/unarchive and WSL soft delete). */
    bool moveNoClobber(const QString &from, const QString &to, QString *error) const;
    bool removeFile(const QString &path) const;
    bool makeDirectory(const QString &path) const;

    QStringList collectJsonl(const QString &root, bool allowArchive) const;

    /**
     * Run one command inside the distribution and capture stdout.
     *
     * `arguments` is the inner command (`stat …`, `sh -c …`); the `-d/-u` prefix, the
     * sanitized environment and the batch-shim wrapping are applied here, so callers can
     * never drift into building a shell string. Stdout is kept even on a timeout: the
     * batch reader's partial-prefix recovery needs it.
     */
    sessioncmd::Result runCapture(const QStringList &arguments, int timeoutMs, qint64 maxOutput) const;

    /** `stat` version used by the summary cache and the paging cursor. */
    bool statVersion(const QString &path, qint64 *mtimeMs, qint64 *size) const;

private:
    Config m_config;
};
