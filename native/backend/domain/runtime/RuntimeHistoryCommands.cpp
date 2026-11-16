#include "RuntimeCoordinator.h"

#include "SessionFileMutations.h"

#include "../pi/ModelThinkingSupport.h"
#include "../sessions/HistoryPager.h"
#include "../sessions/HistoryText.h"
#include "../sessions/JsonlIndex.h"
#include "../sessions/PiTaskMessage.h"
#include "../sessions/SessionIdentity.h"
#include "../sessions/SessionMessageTargeting.h"

#include <QDateTime>

#include <limits>

namespace runtime {
namespace {

constexpr int kStateTimeoutMs = 30'000;
constexpr int kReloadTimeoutMs = 30'000;

QJsonObject findMessage(const AgentSession &session, const QString &messageId)
{
    for (const QJsonValue &value : session.transcript().messages()) {
        const QJsonObject message = value.toObject();
        if (message.value(QStringLiteral("id")).toString() == messageId) return message;
    }
    return {};
}

/**
 * Build the file mutation target for a renderer message id.
 *
 * Same ladder as `AgentManager.locateMessageTarget`:
 *  1. the live row's `meta.entryId` when the projection had an entry id (live text wins);
 *  2. file-level id lookup (JSONL `message.id`, raw entry id, synthetic history id) — the
 *     file text wins here, because the row was located without the live cache;
 *  3. turn-anchored mapping for a live UUID that never appears in the file — the abort
 *     case, where the file has one extra empty assistant and a total-count alignment
 *     would shift every later row by one (live text wins);
 *  4. role + text equality inside SessionFileMutations (the oracle's last resort, which
 *     also compares against the *live* text for the same reason).
 *
 * Steps 1/3/4 keep the cached row's text/images (the oracle returns those), so a
 * host-instruction rewritten prompt is resent as the user saw it, not as the file
 * recorded the original. Only step 2 (the id is a real file id) uses the file text.
 */
bool resolveMutationTarget(const ChannelServices &services, const AgentSession &session,
                           const QString &filePath, const QString &messageId, const QString &agentId,
                           sessionmutations::Target *mutation)
{
    mutation->legacyMessageId = messageId;
    mutation->legacyAgentId = agentId;
    const QJsonObject live = findMessage(session, messageId);
    bool liveText = false;
    if (!live.isEmpty()) {
        mutation->entryId = live.value(QStringLiteral("meta")).toObject()
                                .value(QStringLiteral("entryId")).toString();
        mutation->role = live.value(QStringLiteral("role")).toString();
        mutation->text = live.value(QStringLiteral("text")).toString();
        const QJsonArray images = live.value(QStringLiteral("images")).toArray();
        mutation->images = images;
        liveText = !mutation->entryId.isEmpty();
    }
    if (mutation->entryId.isEmpty() && !filePath.isEmpty()) {
        try {
            const JsonlIndex index = services.indexStore ? services.indexStore->get(filePath)
                                                          : jsonlindex::build(filePath);
            // Oracle step 2: the renderer id *is* a file id, so the file is authoritative.
            if (!historytext::readMessageByMessageId(index, messageId).found) {
                mutation->entryId = messagetargeting::locateActiveEntry(
                    index, session.transcript().messages(), messageId,
                    live.value(QStringLiteral("text")).toString());
                // Step 3/4: located through the turn mapping or not at all.
                liveText = !live.isEmpty();
            }
        } catch (const std::exception &) {
            // The file may have vanished mid-flight; resolveTarget below reports the
            // readable failure instead of a stale index error.
        }
    }
    QString error;
    const bool resolved = sessionmutations::resolveTarget(filePath, mutation, &error);
    if (resolved && liveText) {
        // `resolveTarget` reads role/text/images from the file entry; the oracle keeps the
        // live row for these fields (only the entry id comes from the file).
        mutation->text = live.value(QStringLiteral("text")).toString();
        mutation->images = live.value(QStringLiteral("images")).toArray();
    }
    return resolved;
}

/** Reload the runtime after a file mutation; restore the backup when pi refuses. */
void reloadAfterMutation(AgentSession &session, const QString &filePath, const QString &backupPath,
                         std::function<void(bool, const QString &)> done)
{
    session.request(QStringLiteral("switch_session"),
                    QJsonObject{{QStringLiteral("sessionPath"), filePath}}, kReloadTimeoutMs,
                    [filePath, backupPath, done](bool ok, const QJsonObject &response,
                                                 const QString &error) {
                        const bool success = ok && response.value(QStringLiteral("success")).toBool(false);
                        if (success) {
                            done(true, QString());
                            return;
                        }
                        const QString failure = !error.isEmpty()
                            ? error
                            : response.value(QStringLiteral("error")).toString(
                                  QStringLiteral("Session reload failed"));
                        // The file was already rewritten; put the original back so the user
                        // never loses a turn to a failed reload.
                        sessionmutations::restoreBackup(filePath, backupPath);
                        done(false, failure);
                    });
}

} // namespace

void Coordinator::editMessage(const QJsonObject &target, const QString &messageId,
                              const QString &newText, std::function<void(QJsonObject)> done)
{
    runHistoryMutation(target, [this, messageId, newText](AgentSession &session, const Target &binding,
                                                          CommandDone finish) {
        const QString agentId = binding.agentId;
        const QString filePath = session.tab().sessionPath;
        if (filePath.isEmpty()) {
            finish(false, QJsonValue(), QStringLiteral("Session file is not available"));
            return;
        }
        sessionmutations::Target mutation;
        if (!resolveMutationTarget(*m_deps.services, session, filePath, messageId, binding.agentId,
                                    &mutation)) {
            finish(false, QJsonValue(), QStringLiteral("Message not found: %1").arg(messageId));
            return;
        }
        const sessionmutations::Result result = sessionmutations::edit(filePath, mutation, newText);
        if (!result.ok) {
            finish(false, QJsonValue(), result.error);
            return;
        }
        reloadAfterMutation(session, filePath, result.backupPath,
                            [this, agentId, finish](bool ok, const QString &error) {
                                if (!ok) {
                                    finish(false, QJsonValue(), error);
                                    return;
                                }
                                reloadProjection(agentId, finish);
                            });
    }, std::move(done));
}

void Coordinator::deleteMessage(const QJsonObject &target, const QString &messageId,
                                std::function<void(QJsonObject)> done)
{
    runHistoryMutation(target, [this, messageId](AgentSession &session, const Target &binding,
                                                 CommandDone finish) {
        const QString agentId = binding.agentId;
        const QString filePath = session.tab().sessionPath;
        if (filePath.isEmpty()) {
            finish(false, QJsonValue(), QStringLiteral("Session file is not available"));
            return;
        }
        sessionmutations::Target mutation;
        if (!resolveMutationTarget(*m_deps.services, session, filePath, messageId, binding.agentId,
                                    &mutation)) {
            finish(false, QJsonValue(), QStringLiteral("Message not found: %1").arg(messageId));
            return;
        }
        const sessionmutations::Result result = sessionmutations::remove(filePath, mutation);
        if (!result.ok) {
            finish(false, QJsonValue(), result.error);
            return;
        }
        reloadAfterMutation(session, filePath, result.backupPath,
                            [this, agentId, finish](bool ok, const QString &error) {
                                if (!ok) {
                                    finish(false, QJsonValue(), error);
                                    return;
                                }
                                reloadProjection(agentId, finish);
                            });
    }, std::move(done));
}

void Coordinator::prepareResend(const QJsonObject &target, const QString &messageId,
                                const QJsonObject &model, const QString &thinkingLevel,
                                std::function<void(QJsonObject)> done)
{
    runHistoryMutation(target, [this, messageId, model, thinkingLevel](
                                   AgentSession &session, const Target &binding, CommandDone finish) {
        const QString agentId = binding.agentId;
        const QString filePath = session.tab().sessionPath;
        if (filePath.isEmpty()) {
            finish(false, QJsonValue(), QStringLiteral("Session file is not available"));
            return;
        }
        sessionmutations::Target mutation;
        if (!resolveMutationTarget(*m_deps.services, session, filePath, messageId, binding.agentId,
                                    &mutation)) {
            finish(false, QJsonValue(), QStringLiteral("Message not found: %1").arg(messageId));
            return;
        }
        const sessionmutations::Result result = sessionmutations::truncateForResend(filePath, mutation);
        if (!result.ok) {
            finish(false, QJsonValue(), result.error);
            return;
        }
        reloadAfterMutation(session, filePath, result.backupPath,
                            [this, agentId, binding, mutation, model, thinkingLevel, finish](
                                bool ok, const QString &error) {
                                if (!ok) {
                                    finish(false, QJsonValue(), error);
                                    return;
                                }
                                QJsonObject value{
                                    {QStringLiteral("text"), mutation.text},
                                };
                                if (!mutation.images.isEmpty()) {
                                    value.insert(QStringLiteral("images"), mutation.images);
                                }
                                // switch_session resets pi's in-memory model/thinking to the
                                // historical values; re-apply the current selection.
                                auto finishReload = [this, agentId, value, finish]() {
                                    CommandDone settled = [value, finish](bool ok, const QJsonValue &,
                                                                         const QString &error) {
                                        if (!ok) {
                                            finish(false, QJsonValue(), error);
                                            return;
                                        }
                                        finish(true, value, QString());
                                    };
                                    reloadProjection(agentId, std::move(settled));
                                };
                                auto restoreThinking = [this, agentId, binding, thinkingLevel,
                                                        model, finishReload]() {
                                    AgentSession *current = agent(agentId);
                                    if (!current) {
                                        finishReload();
                                        return;
                                    }
                                    if (thinkingLevel.isEmpty()) {
                                        finishReload();
                                        return;
                                    }
                                    // `switch_session` reset pi's in-memory level to the
                                    // historical one: re-apply the current selection, but
                                    // clamp an extended level the restored model no longer
                                    // declares (same rule as activation/model switch).
                                    QString desired = thinkingLevel;
                                    const QString provider =
                                        model.value(QStringLiteral("provider")).toString();
                                    const QString modelId =
                                        model.value(QStringLiteral("modelId")).toString();
                                    modellist::ThinkingSupport support;
                                    if (!provider.isEmpty() && !modelId.isEmpty()
                                        && modellist::isExtendedThinkingLevel(thinkingLevel)
                                        && resolveThinkingSupport(provider, modelId, &support)) {
                                        desired = modellist::clampThinkingLevel(thinkingLevel, support);
                                    }
                                    current->request(
                                        QStringLiteral("set_thinking_level"),
                                        QJsonObject{{QStringLiteral("level"), desired}},
                                        kStateTimeoutMs,
                                        [this, agentId, binding, thinkingLevel, finishReload](
                                            bool ok, const QJsonObject &response, const QString &) {
                                            if (ok
                                                && response.value(QStringLiteral("success"))
                                                       .toBool(false)) {
                                                const QString effective =
                                                    response.value(QStringLiteral("data"))
                                                        .toObject()
                                                        .value(QStringLiteral("thinkingLevel"))
                                                        .toString();
                                                // Only a level pi actually changed is
                                                // persisted/toasted; a rejected restore stays
                                                // silent (the next activation retries).
                                                if (!effective.isEmpty()
                                                    && effective != thinkingLevel) {
                                                    persistAdjustedThinking(binding.sessionId,
                                                                            agentId, thinkingLevel,
                                                                            effective);
                                                }
                                            }
                                            finishReload();
                                        });
                                };
                                const QString provider = model.value(QStringLiteral("provider")).toString();
                                const QString modelId = model.value(QStringLiteral("modelId")).toString();
                                AgentSession *current = agent(agentId);
                                if (!current || provider.isEmpty() || modelId.isEmpty()) {
                                    restoreThinking();
                                    return;
                                }
                                current->request(QStringLiteral("set_model"),
                                                 QJsonObject{{QStringLiteral("provider"), provider},
                                                             {QStringLiteral("modelId"), modelId}},
                                                 kStateTimeoutMs,
                                                 [restoreThinking](bool, const QJsonObject &, const QString &) {
                                                     restoreThinking();
                                                 });
                            });
    }, std::move(done));
}

bool Coordinator::tryReadRuntimeTurnPage(const QString &sessionId, const QString &filePath,
                                         const QString &beforeEntryId, bool hasBefore, int before,
                                         int turnCount, historypager::Page *page)
{
    if (!page) return false;
    const QString agentId = m_bindings.agentForSession(sessionId);
    if (agentId.isEmpty()) return false;
    const AgentSession *session = agent(agentId);
    if (!session) return false;
    const QJsonArray &list = session->transcript().messages();
    if (list.isEmpty()) return false;

    // Defence in depth: the binding may already point at a replaced session while a late
    // page request still names the old file. Only the runtime that owns this file may
    // answer from its cache; everything else falls back to the file reader.
    QString environment = session->tab().sessionEnvironment;
    if (!sessionidentity::isValidEnvironment(environment)) environment = QStringLiteral("native");
    const QString runtimePath = session->tab().sessionPath;
    if (!runtimePath.isEmpty()
        && sessionidentity::canonicalizeSessionPath(runtimePath, environment)
            != sessionidentity::canonicalizeSessionPath(filePath, environment)) {
        return false;
    }

    JsonlIndex index;
    try {
        index = m_deps.services && m_deps.services->indexStore
            ? m_deps.services->indexStore->get(filePath)
            : jsonlindex::build(filePath);
    } catch (const std::exception &) {
        return false;
    }

    const auto liveEntryIdAt = [&list](int position) {
        if (position < 0 || position >= list.size()) return QString();
        return list.at(position).toObject().value(QStringLiteral("meta")).toObject()
            .value(QStringLiteral("entryId")).toString();
    };
    const auto liveIndexForEntryId = [&list](const QString &entryId) {
        if (entryId.isEmpty()) return -1;
        for (int position = 0; position < list.size(); ++position) {
            const QJsonObject message = list.at(position).toObject();
            if (message.value(QStringLiteral("meta")).toObject()
                    .value(QStringLiteral("entryId")).toString()
                == entryId) {
                return position;
            }
        }
        return -1;
    };

    int position = -1;
    if (!beforeEntryId.isEmpty()) {
        // Entry id is the only cross-space anchor; the renderer sends it on every turn.
        position = liveIndexForEntryId(beforeEntryId);
    } else if (hasBefore) {
        // A numeric cursor is a file index: resolve it to an entry id first, then look
        // that entry up in the runtime window. Treating the number as a runtime index
        // would silently page the wrong rows after an abort/trim.
        const int filePosition = qBound(0, before, index.activeMessageEntries.size());
        if (filePosition >= index.activeMessageEntries.size()) return false;
        const QString anchorId = index.activeMessageEntries.at(filePosition).id;
        position = liveIndexForEntryId(anchorId);
        // The cache's first row has nothing older behind it; the file owns that history.
        if (position == 0) return false;
    }
    if (position < 0) return false;

    const int turns = qBound(1, turnCount, historypager::kMaxTurnPageSize);
    QVector<IndexEntry> roles;
    roles.reserve(list.size());
    for (const QJsonValue &value : list) {
        const QJsonObject message = value.toObject();
        IndexEntry entry;
        entry.role = message.value(QStringLiteral("role")).toString();
        // Task cards are system rows but start a turn, exactly like the oracle's
        // `turnBoundary: isTodoTaskCard(message)`; byteLength stays 0 because this page
        // is bounded by turns only (the file reader applies the byte budget).
        entry.turnBoundary = pitask::isTodoTaskCard(value);
        roles.append(entry);
    }
    const int start = historypager::findTurnPageStart(
        roles, position, turns, std::numeric_limits<qint64>::max());
    if (start >= position) return false;

    QJsonArray messages;
    for (int cursor = start; cursor < position; ++cursor) messages.append(list.at(cursor));
    const QString oldestEntryId = liveEntryIdAt(start);
    if (oldestEntryId.isEmpty()) return false;
    int resolvedOldest = -1;
    for (int cursor = 0; cursor < index.activeMessageEntries.size(); ++cursor) {
        if (index.activeMessageEntries.at(cursor).id == oldestEntryId) {
            resolvedOldest = cursor;
            break;
        }
    }
    // nextBefore must stay in the file index space; without a resolvable anchor the
    // renderer would be handed a runtime index that no later read can interpret.
    if (resolvedOldest < 0) return false;

    page->messages = messages;
    page->total = index.activeMessageEntries.size();
    page->hasNextBefore = true;
    page->nextBefore = resolvedOldest;
    page->nextBeforeEntryId = oldestEntryId;
    page->indexVersion = index.version();
    return true;
}

void Coordinator::reloadProjection(const QString &agentId, CommandDone finish)
{
    AgentSession *current = agent(agentId);
    if (!current) {
        finish(false, QJsonValue(), QStringLiteral("Session runtime stopped during reload"));
        return;
    }
    loadProjection(*current, [this, agentId, finish](bool projected) {
        AgentSession *latest = agent(agentId);
        if (!projected || !latest || !latest->running()) {
            finish(false, QJsonValue(), QStringLiteral("Session projection unavailable during reload"));
            return;
        }
        agentruntime::flushMessages(*latest, hooksFor(*latest));
        finish(true, QJsonValue(QJsonValue::Null), QString());
    });
}


} // namespace runtime
