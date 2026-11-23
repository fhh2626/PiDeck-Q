#pragma once

#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>

class PiEventClient;
class QTimer;

/**
 * Lightweight pi process used only for git commit-message generation.
 *
 * Port of src/main/git/QuickGenerator.ts: one reusable `--mode rpc --no-session
 * --no-tools` pi process, a single in-flight generation, a 60 s generation timeout and
 * a 30 min idle shutdown. The result is the concatenated `text_delta` stream, so pi
 * stays the only owner of model behaviour — the backend never synthesizes a message.
 */
class QuickGenerator : public QObject {
public:
    using Result = std::function<void(bool ok, const QString &message, const QString &error)>;
    using SettingsProvider = std::function<QJsonObject()>;

    explicit QuickGenerator(SettingsProvider settings, QObject *parent = nullptr);
    ~QuickGenerator() override;

    void generate(const QString &projectPath, const QString &prompt, const QString &provider, const QString &modelId,
                  Result done);

    /** Reject in-flight work and stop the child; called from the shutdown sequence. */
    void dispose();

    static constexpr int kGenerationTimeoutMs = 60'000;
    static constexpr int kIdleShutdownMs = 30 * 60'000;

private:
    struct Generation {
        QStringList collected;
        bool settled = false;
        Result done;
    };

    bool ensureProcess(const QString &projectPath, const QString &provider, const QString &modelId);
    void stopProcess(const QString &reason);
    void finish(bool ok, const QString &message, const QString &error);
    void resetIdleTimer();

    SettingsProvider m_settings;
    std::unique_ptr<PiEventClient> m_client;
    std::shared_ptr<Generation> m_active;
    QTimer *m_idleTimer = nullptr;
    QTimer *m_generationTimer = nullptr;
    QString m_modelKey;
    bool m_busy = false;
    bool m_disposed = false;
};
