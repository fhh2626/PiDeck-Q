#include "RuntimeCoordinator.h"

#include "RuntimeNotices.h"

#include "../pi/ModelListCache.h"
#include "../pi/ModelThinkingSupport.h"
#include "../sessions/SessionCatalogStore.h"

#include <QDateTime>

namespace runtime {
namespace {

constexpr int kStateTimeoutMs = 30'000;

/** Level pi reported for a `set_thinking_level` reply, or `fallback` when absent. */
QString acceptedThinkingLevel(const QJsonObject &response, const QString &fallback)
{
    return response.value(QStringLiteral("data"))
        .toObject()
        .value(QStringLiteral("thinkingLevel"))
        .toString(fallback);
}

} // namespace

void Coordinator::persistAdjustedThinking(const QString &sessionId, const QString &agentId,
                                          const QString &fromLevel, const QString &toLevel)
{
    // Catalog write then notice, exactly like `persistAdjustedThinking`: a toast that
    // cannot be written must not undo the level pi already accepted.
    if (m_deps.services && m_deps.services->catalog) {
        try {
            m_deps.services->catalog->update(
                sessionId,
                QJsonObject{{QStringLiteral("thinkingLevel"), toLevel},
                            {QStringLiteral("updatedAt"),
                             static_cast<double>(QDateTime::currentMSecsSinceEpoch())}});
        } catch (const std::exception &) {
            // A missing/anonymous record is not fatal: the toast below is still true.
        }
    }
    emitNoticeForSession(sessionId, agentId,
                         notices::thinkingUnsupported(agentId, fromLevel, toLevel));
}

bool Coordinator::resolveThinkingSupport(const QString &provider, const QString &modelId,
                                         modellist::ThinkingSupport *support) const
{
    if (!m_deps.services) return false;
    return modellist::resolveSupport(*m_deps.services, provider, modelId, support);
}

QString Coordinator::desiredThinkingLevel(const CatalogEntry &entry) const
{
    if (!entry.hasThinkingLevel || entry.thinkingLevel.isEmpty()) return QString();
    // Base levels are model-independent: only an extended level needs `models.json`.
    if (!entry.hasModel || entry.modelProvider.isEmpty() || entry.modelId.isEmpty()
        || !modellist::isExtendedThinkingLevel(entry.thinkingLevel)) {
        return entry.thinkingLevel;
    }
    modellist::ThinkingSupport support;
    // Unknown support (unreadable/corrupt models.json) keeps the stored level: a transient
    // I/O failure must never silently downgrade the user's preference.
    if (!resolveThinkingSupport(entry.modelProvider, entry.modelId, &support)) {
        return entry.thinkingLevel;
    }
    return modellist::clampThinkingLevel(entry.thinkingLevel, support);
}

void Coordinator::applyThinkingPreference(AgentSession &session, const CatalogEntry &entry,
                                          std::function<void()> done)
{
    const QString agentId = session.tab().id;
    const QString sessionId = entry.id;
    const QString desired = desiredThinkingLevel(entry);
    if (desired.isEmpty()) {
        done();
        return;
    }
    session.request(
        QStringLiteral("set_thinking_level"), QJsonObject{{QStringLiteral("level"), desired}},
        kStateTimeoutMs,
        [this, agentId, sessionId, entry, desired, done](bool ok, const QJsonObject &response,
                                                        const QString &) {
            // Preferences are advisory in this backend: pi rejecting a stored level keeps
            // the session usable (the oracle throws and fails activation; the divergence is
            // recorded in the plan's residual table).
            const QString effective =
                ok && response.value(QStringLiteral("success")).toBool(false)
                ? acceptedThinkingLevel(response, desired)
                : desired;
            // Only a real change is written and toasted: `app.thinkingUnsupported` tells the
            // user why the picker no longer shows the stored level.
            if (effective != entry.thinkingLevel) {
                persistAdjustedThinking(sessionId, agentId, entry.thinkingLevel, effective);
            }
            done();
        });
}

void Coordinator::alignThinkingAfterModelChange(const QString &sessionId, const QString &agentId,
                                               const QString &level, const QString &provider,
                                               const QString &modelId, const QString &runtimeLevel,
                                               std::function<void()> done)
{
    const auto finish = [done]() {
        if (done) done();
    };
    // Base levels are model-independent: no models.json read and no catalog write.
    if (level.isEmpty() || !modellist::isExtendedThinkingLevel(level)) {
        finish();
        return;
    }
    modellist::ThinkingSupport support;
    // Unknown config (unreadable/corrupt) must not downgrade a preference.
    if (!resolveThinkingSupport(provider, modelId, &support)) {
        finish();
        return;
    }
    const QString next = modellist::clampThinkingLevel(level, support);
    const bool piKeptLevel = runtimeLevel.isEmpty() || runtimeLevel == level;
    // Still supported and pi did not change the level: no extra RPC, no toast.
    if (next == level && piKeptLevel) {
        finish();
        return;
    }
    if (runtimeLevel == next) {
        // pi already landed on the target (it clamped on its own): sync + notify only.
        persistAdjustedThinking(sessionId, agentId, level, next);
        finish();
        return;
    }
    AgentSession *session = agent(agentId);
    if (!session) {
        finish();
        return;
    }
    session->request(
        QStringLiteral("set_thinking_level"),
        QJsonObject{{QStringLiteral("level"), next}}, kStateTimeoutMs,
        [this, sessionId, agentId, level, next, finish](bool ok, const QJsonObject &response,
                                                       const QString &) {
            if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                // Alignment failure must not fail the model switch and must not touch the
                // catalog: the next activation retries from the stored preference.
                finish();
                return;
            }
            const QString effective = acceptedThinkingLevel(response, next);
            if (effective != level) {
                persistAdjustedThinking(sessionId, agentId, level, effective);
            }
            finish();
        });
}

} // namespace runtime
