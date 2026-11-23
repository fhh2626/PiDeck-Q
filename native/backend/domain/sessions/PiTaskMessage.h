#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

/**
 * Desktop projection of the neutral custom messages emitted by the standalone todo
 * extension (port of src/shared/piTaskMessage.ts).
 *
 * A task start or its resume guidance is a real custom entry, not an editable user
 * message. Browsing adapts it for display only; the persisted JSONL is never rewritten
 * and no synthetic user record is manufactured.
 */
namespace pitask {

extern const char *const kTodoTaskStart;
/** User guidance that resumed a blocked goal: same read-only card, different label. */
extern const char *const kTodoTaskResume;

/** `goal` starts a task, `resume` is the guidance that unblocked it. */
enum class Kind { Goal, Resume };

struct TaskMessage {
    Kind kind = Kind::Goal;
    QString text;
};

struct TaskCommand {
    QString name;
    QString args;
};

/**
 * Only explicitly visible (`display: true`) task messages are user turns; task rules
 * and continuation prompts stay hidden.
 */
bool readTodoTaskMessage(const QJsonValue &value, TaskMessage *message);

/** Goal-only reader: session titles and previews keep using the original task. */
bool readTodoTaskGoal(const QJsonValue &value, QString *goal);

/** Original slash command, kept separate from the neutral model goal by new senders. */
bool readTodoTaskCommand(const QJsonValue &value, TaskCommand *command);

/** Match only the adjacent host-created command and retain its visible/request identity. */
bool acknowledgeTodoCommand(const QJsonObject &pending, const QJsonObject &card,
                            QJsonObject *acknowledged);

/**
 * Sender-provided identity for one task message. Live events and projected history must
 * agree on it, otherwise a genuinely new resume is mistaken for a replayed card.
 */
bool readTodoTaskMessageId(const QJsonValue &value, QString *messageId);

/** Pi entries store ISO timestamps while chat messages use epoch milliseconds. */
bool toEpochMs(const QJsonValue &value, double *epochMs);

/** Adapt one JSONL entry for browsing: `{type, message}`. */
QJsonObject displayEntry(const QJsonObject &entry);

/**
 * Desktop task cards are projected as `system` for read-only safety, yet they start a
 * turn. Both the live cache and the file index must agree on that boundary.
 */
bool isTodoTaskCard(const QJsonValue &message);

/** Raw Pi task messages and their read-only desktop cards are user-initiated turn boundaries. */
bool isPiUserTurn(const QJsonValue &message);

} // namespace pitask
