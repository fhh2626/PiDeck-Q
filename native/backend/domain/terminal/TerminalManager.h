#pragma once

#include "PtyProcess.h"
#include "TerminalTarget.h"

#include <QByteArray>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>

#include <atomic>

class QStringDecoder;

/**
 * Owner of every terminal tab in the backend.
 *
 * Port of `TerminalSessionManager` from src/main/terminal/TerminalSessionManager.ts.
 * Responsibilities, in the same order the oracle applies them:
 *  - isolate PTYs and replay buffers per ownership key (`agent:<id>` / `cwd:<path>`);
 *  - keep a bounded replay buffer so remounting the dock can rebuild scrollback;
 *  - emit `terminal:data` / `terminal:exit` with the tab id;
 *  - tear a tab (and its process) down on close, agent exit and shutdown.
 *
 * All state is owned by the thread that created the manager (the Qt event loop). PTY
 * callbacks arrive on worker threads and are re-posted as queued invocations, so the
 * replay buffer and the tab table are never touched concurrently.
 */
namespace terminal {

class Manager : public QObject {
public:
    /** Replay cap in UTF-16 code units, identical to MAX_TERMINAL_REPLAY_BUFFER. */
    static constexpr int kMaxReplayBuffer = 200'000;

    /** Validate an agent target; returns false with a renderer-facing message. */
    using TargetValidator = std::function<bool(const QJsonObject &target, QString *error)>;
    /** Working directory of a live agent runtime. */
    using CwdResolver = std::function<QString(const QString &agentId)>;
    /** Broadcast one renderer event (`terminal:data` / `terminal:exit`). */
    using Emitter = std::function<void(const QString &channel, const QJsonArray &args)>;

    Manager(TargetValidator validator, CwdResolver cwdResolver, Emitter emitter, QObject *parent = nullptr);
    ~Manager() override;

    /** `terminal:list` — snapshots (with replay buffer) for the target's owner. */
    QJsonArray list(const QJsonObject &target);

    /** `terminal:ensure` — the existing tabs, or a single freshly created one. */
    QJsonArray ensure(const QJsonObject &target);

    /** `terminal:create` — one new tab. */
    QJsonObject create(const QJsonObject &target, const QString &preferredShell = QString());

    /** `terminal:input` — throws `Terminal not found: <id>` for an unknown tab. */
    void input(const QString &tabId, const QString &data);

    /** `terminal:resize` — silently ignored for a closed or unknown tab. */
    void resize(const QString &tabId, int cols, int rows);

    /** `terminal:close` — kills the process and forgets the tab. */
    void close(const QString &tabId);

    /** Close every terminal owned by one agent (agent exit / restart). */
    void closeAgent(const QString &agentId);

    /** Close every terminal; called from the shutdown sequence. */
    void closeAll();

    /** `terminal:shells` — `[{shell, label, available}]`. */
    QJsonArray shells() const;

    int tabCount() const;

private:
    struct Tab {
        QString id;
        QString agentId;
        QString ownerKey;
        QString title;
        QString cwd;
        QString shell;
        qint64 createdAt = 0;
        bool exited = false;
        bool hasExitCode = false;
        int exitCode = 0;
        QString buffer;
        std::unique_ptr<QStringDecoder> decoder;
        std::unique_ptr<PtyProcess> process;

        QJsonObject toJson(bool includeBuffer) const;
    };

    struct Owner {
        QHash<QString, std::shared_ptr<Tab>> tabs;
    };

    /** Resolve + validate the target, then compute its ownership key and cwd. */
    void resolveTarget(const QJsonObject &target, Target *parsed, QString *ownerKey, QString *cwd) const;
    std::shared_ptr<Tab> findTab(const QString &tabId, QString *ownerKey) const;
    std::shared_ptr<Tab> requireTab(const QString &tabId);
    QHash<QString, std::shared_ptr<Tab>> &ensureOwner(const QString &ownerKey);
    void closeOwner(const QString &ownerKey);
    void appendBuffer(Tab &tab, const QString &data);
    void handleData(const QString &tabId, const QByteArray &bytes);
    void handleExit(const QString &tabId, int exitCode);
    std::unique_ptr<PtyProcess> spawnShell(const QString &cwd, const QString &preferredShell,
                                           const PtyProcess::Callbacks &callbacks, QString *shellId,
                                           QString *error);

    TargetValidator m_validator;
    CwdResolver m_cwdResolver;
    Emitter m_emitter;
    QHash<QString, Owner> m_owners;
    /**
     * False once the destructor started. PTY threads check it before posting, so a
     * callback that races with teardown cannot touch a half-destroyed manager.
     */
    std::shared_ptr<std::atomic<bool>> m_alive = std::make_shared<std::atomic<bool>>(true);
};

} // namespace terminal
