#include "QuickGenerator.h"

#include "PiCommand.h"
#include "PiEventClient.h"

#include <QJsonArray>
#include <QJsonValue>
#include <QTimer>

#include <utility>

namespace {

/** The auxiliary pi process never needs tools, extensions, skills or a session. */
QStringList generatorArguments()
{
    return {QStringLiteral("--mode"),      QStringLiteral("rpc"),
            QStringLiteral("--no-session"), QStringLiteral("--no-tools"),
            QStringLiteral("--no-extensions"), QStringLiteral("--no-skills"),
            QStringLiteral("--no-prompt-templates"), QStringLiteral("--no-themes"),
            QStringLiteral("--thinking"),  QStringLiteral("off")};
}

} // namespace

QuickGenerator::QuickGenerator(SettingsProvider settings, QObject *parent)
    : QObject(parent), m_settings(std::move(settings))
{
    m_idleTimer = new QTimer(this);
    m_idleTimer->setSingleShot(true);
    m_idleTimer->setInterval(kIdleShutdownMs);
    connect(m_idleTimer, &QTimer::timeout, this, [this] { stopProcess(QStringLiteral("QuickGen process stopped")); });

    m_generationTimer = new QTimer(this);
    m_generationTimer->setSingleShot(true);
    m_generationTimer->setInterval(kGenerationTimeoutMs);
    connect(m_generationTimer, &QTimer::timeout, this, [this] {
        finish(false, QString(), QStringLiteral("Quick generate timed out"));
        stopProcess(QStringLiteral("Quick generate timed out"));
    });
}

QuickGenerator::~QuickGenerator()
{
    dispose();
}

void QuickGenerator::dispose()
{
    if (m_disposed) return;
    m_disposed = true;
    stopProcess(QStringLiteral("QuickGen is disposed"));
}

bool QuickGenerator::ensureProcess(const QString &projectPath, const QString &provider, const QString &modelId)
{
    const QString modelKey = provider + QChar(0) + modelId;
    // A provider/model change must restart the process: the old model state cannot be
    // reused for a different model.
    if (m_client && m_client->running() && m_modelKey == modelKey) return true;
    stopProcess(QStringLiteral("QuickGen process stopped"));

    const QJsonObject settings = m_settings ? m_settings() : QJsonObject();
    const picommand::Invocation invocation = picommand::resolve(settings);
    m_client = std::make_unique<PiEventClient>();
    if (!m_client->start(invocation.program, invocation.arguments + generatorArguments(), projectPath,
                         picommand::environment(settings, invocation))) {
        m_client.reset();
        return false;
    }
    return true;
}

void QuickGenerator::generate(const QString &projectPath, const QString &prompt, const QString &provider,
                             const QString &modelId, Result done)
{
    if (m_disposed) {
        if (done) done(false, QString(), QStringLiteral("QuickGen is disposed"));
        return;
    }
    if (m_busy) {
        // pi rejects a second prompt while it is processing; report the same condition
        // so the renderer can localize it instead of showing a technical error.
        if (done) done(false, QString(), QStringLiteral("Agent is already processing"));
        return;
    }
    m_busy = true;
    if (m_idleTimer) m_idleTimer->stop();
    if (m_generationTimer) m_generationTimer->stop();

    auto generation = std::make_shared<Generation>();
    generation->done = std::move(done);
    m_active = generation;

    if (!ensureProcess(projectPath, provider, modelId)) {
        m_busy = false;
        m_active.reset();
        if (generation->done) generation->done(false, QString(), QStringLiteral("QuickGen RPC pipes unavailable"));
        return;
    }

    PiEventClient *client = m_client.get();
    client->setEventHandler([this, generation](const QJsonObject &event) {
        if (generation->settled) return;
        const QString type = event.value(QStringLiteral("type")).toString();
        if (type == QLatin1String("message_update")) {
            const QJsonObject update = event.value(QStringLiteral("assistantMessageEvent")).toObject();
            if (update.value(QStringLiteral("type")).toString() == QLatin1String("text_delta")) {
                const QJsonValue delta = update.value(QStringLiteral("delta"));
                if (delta.isString()) generation->collected.append(delta.toString());
            }
        }
        if (type == QLatin1String("agent_settled") || type == QLatin1String("agent_end")) {
            finish(true, generation->collected.join(QString()), QString());
        }
    });

    if (m_generationTimer) m_generationTimer->start();

    const QString modelKey = provider + QChar(0) + modelId;
    client->request(QJsonObject{{QStringLiteral("type"), QStringLiteral("set_model")},
                               {QStringLiteral("provider"), provider},
                               {QStringLiteral("modelId"), modelId}},
                    15'000, [this, generation, client, projectPath, prompt, modelKey](bool ok, const QJsonObject &response,
                                                                                     const QString &error) {
        if (generation->settled) return;
        if (!ok || !response.value(QStringLiteral("success")).toBool(true)) {
            finish(false, QString(), error.isEmpty() ? response.value(QStringLiteral("error")).toString(
                                                          QStringLiteral("Unable to select QuickGen model"))
                                                    : error);
            stopProcess(QStringLiteral("QuickGen process stopped"));
            return;
        }
        m_modelKey = modelKey;
        Q_UNUSED(projectPath);
        client->request(QJsonObject{{QStringLiteral("type"), QStringLiteral("prompt")},
                                    {QStringLiteral("message"), prompt}},
                        15'000, [this, generation](bool prompted, const QJsonObject &promptResponse,
                                                   const QString &promptError) {
            if (generation->settled) return;
            if (prompted && promptResponse.value(QStringLiteral("success")).toBool(true)) return;
            const QString message = promptError.isEmpty()
                ? promptResponse.value(QStringLiteral("error")).toString(QStringLiteral("Prompt rejected"))
                : promptError;
            finish(false, QString(), message);
            // A lost prompt acknowledgement has an uncertain result: never reuse the
            // process while the previous generation may still be running.
            stopProcess(message);
        });
    });
}

void QuickGenerator::finish(bool ok, const QString &message, const QString &error)
{
    const std::shared_ptr<Generation> generation = m_active;
    if (!generation || generation->settled) return;
    generation->settled = true;
    if (m_generationTimer) m_generationTimer->stop();
    if (m_client) m_client->setEventHandler(nullptr);
    m_active.reset();
    m_busy = false;
    if (ok) {
        resetIdleTimer();
    }
    if (generation->done) generation->done(ok, message, error);
}

void QuickGenerator::stopProcess(const QString &reason)
{
    if (m_idleTimer) m_idleTimer->stop();
    if (m_generationTimer) m_generationTimer->stop();
    const std::shared_ptr<Generation> generation = m_active;
    m_active.reset();
    m_busy = false;
    m_modelKey.clear();
    if (m_client) {
        m_client->close(reason);
        m_client.reset();
    }
    if (generation && !generation->settled) {
        generation->settled = true;
        if (generation->done) generation->done(false, QString(), reason);
    }
}

void QuickGenerator::resetIdleTimer()
{
    if (m_disposed || !m_client) return;
    // Idle reuse is bounded; an active generation never owns an idle timer.
    if (m_idleTimer) m_idleTimer->start();
}
