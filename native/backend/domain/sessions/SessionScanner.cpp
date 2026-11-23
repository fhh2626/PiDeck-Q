#include "SessionScanner.h"

#include "MessageContent.h"
#include "PiTaskMessage.h"
#include "SessionFiles.h"
#include "SessionIdentity.h"
#include "SummaryReader.h"

#include "../ChannelRegistry.h"

#include <QDateTime>
#include <QDir>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSet>
#include <QUuid>


namespace {

/**
 * JS `Number(value)` for the reference-message timestamp.
 *
 * The oracle writes `Number(entry.ts ?? entry.timestamp ?? Date.now())`, so an ISO
 * timestamp string becomes `NaN` and `JSON.stringify` serializes it as `null`. That is
 * the observable wire value the renderer already handles; inventing `Date.now()` here
 * would silently swap "unknown time" for "now". Returns false for NaN.
 */
bool jsNumber(const QJsonValue &value, double *out)
{
    switch (value.type()) {
    case QJsonValue::Double: {
        const double number = value.toDouble();
        if (!std::isfinite(number)) return false;
        if (out) *out = number;
        return true;
    }
    case QJsonValue::String: {
        // Number("") === 0 and Number(" 12 ") === 12; anything else is NaN.
        const QString trimmed = value.toString().trimmed();
        if (trimmed.isEmpty()) {
            if (out) *out = 0;
            return true;
        }
        bool ok = false;
        const double number = trimmed.toDouble(&ok);
        if (!ok) return false;
        if (out) *out = number;
        return true;
    }
    case QJsonValue::Bool:
        if (out) *out = value.toBool() ? 1 : 0;
        return true;
    case QJsonValue::Null:
        // Only reached when the key is explicitly null and no later fallback exists;
        // `??` skips null, so callers check that before calling.
        if (out) *out = 0;
        return true;
    default:
        // Objects/arrays are NaN in this position (pi never writes them as timestamps).
        return false;
    }
}

/** `entry.ts ?? entry.timestamp ?? Date.now()` with the oracle's NaN -> null result. */
QJsonValue referenceTimestamp(const QJsonObject &entry)
{
    QJsonValue source = entry.value(QStringLiteral("ts"));
    if (source.isNull() || source.isUndefined()) source = entry.value(QStringLiteral("timestamp"));
    if (source.isNull() || source.isUndefined()) {
        return QJsonValue(double(QDateTime::currentMSecsSinceEpoch()));
    }
    double number = 0;
    if (!jsNumber(source, &number)) return QJsonValue(QJsonValue::Null);
    return QJsonValue(number);
}

} // namespace

QString SessionScanner::siblingDirectory(const QString &filePath) const
{
    if (!filePath.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive)) return QString();
    QString directory = filePath;
    directory.chop(6);
    // Never treat the sessions root itself as a deletable sibling directory.
    if (sessionidentity::normalizeScanPath(directory)
        == sessionidentity::normalizeScanPath(m_config.sessionsDir)) {
        return QString();
    }
    return directory;
}

QString SessionScanner::readSessionRawText(const QString &filePath) const
{
    QString raw;
    QString error;
    if (!fs().readText(filePath, &raw, &error)) {
        throw ChannelError(error.isEmpty() ? QStringLiteral("Unable to read session file") : error);
    }
    return raw;
}

QJsonArray SessionScanner::readReferenceMessages(const QString &filePath) const
{
    const QString raw = readSessionRawText(filePath);
    QJsonArray messages;
    for (const QString &rawLine : raw.split(QLatin1Char('\n'))) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty()) continue;
        QJsonParseError parseError{};
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8(), &parseError);
        if (parseError.error != QJsonParseError::NoError || !document.isObject()) continue;
        const QJsonObject entry = document.object();
        // The atomic task messages (goal and, since e978ad8a, resume guidance) are real
        // custom entries, not editable user messages; both belong to the reference list.
        pitask::TaskMessage task;
        if (pitask::readTodoTaskMessage(QJsonValue(entry), &task)) {
            double parsed = 0;
            if (!pitask::toEpochMs(entry.value(QStringLiteral("timestamp")), &parsed)) {
                parsed = double(QDateTime::currentMSecsSinceEpoch());
            }
            messages.append(QJsonObject{
                {QStringLiteral("role"), QStringLiteral("system")},
                {QStringLiteral("content"), task.text},
                {QStringLiteral("timestamp"), parsed},
            });
            continue;
        }
        const QString type = entry.value(QStringLiteral("type")).toString();
        if (!type.isEmpty() && type != QLatin1String("message")) continue;
        // Legacy PiDeck header rows carry a sessionName but no message; they are not
        // renderable reference messages (oracle `entry.sessionName && !entry.message`).
        if (entry.value(QStringLiteral("sessionName")).isString()
            && entry.value(QStringLiteral("message")).isUndefined()) {
            continue;
        }
        // `entry.message ?? entry.data?.message ?? entry` — null falls through, unlike a
        // mere undefined check.
        QJsonValue messageValue = entry.value(QStringLiteral("message"));
        if (messageValue.isNull() || messageValue.isUndefined()) {
            messageValue = entry.value(QStringLiteral("data")).toObject().value(QStringLiteral("message"));
        }
        if (messageValue.isNull() || messageValue.isUndefined()) messageValue = QJsonValue(entry);
        if (!messageValue.isObject()) continue;
        const QJsonObject message = messageValue.toObject();
        const QString role = message.value(QStringLiteral("role")).toString();
        if (role != QLatin1String("user") && role != QLatin1String("assistant")) continue;
        const QString content = messagecontent::extractMessageText(message.value(QStringLiteral("content"))).trimmed();
        if (content.isEmpty()) continue;
        messages.append(QJsonObject{
            {QStringLiteral("role"), role},
            {QStringLiteral("content"), content},
            {QStringLiteral("timestamp"), referenceTimestamp(entry)},
        });
    }
    return messages;
}

QString SessionScanner::appendSessionInfoLine(const QString &raw, const QString &name,
                                              const QJsonObject &extra) const
{
    // Same sanitization pi applies: a newline in the name would break the JSONL frame.
    QString sanitized = name;
    sanitized.replace(QRegularExpression(QStringLiteral("[\\r\\n]+")), QStringLiteral(" "));
    sanitized = sanitized.trimmed();

    QSet<QString> ids;
    QString lastId;
    QStringList keptLines;
    for (const QString &rawLine : raw.split(QLatin1Char('\n'))) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty()) continue;
        QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        if (document.isObject()) {
            const QJsonObject entry = document.object();
            // Legacy PiDeck header: `sessionName` with no `type`. pi cannot parse it and
            // refuses to load the session when it sits on the first line (#114).
            if (entry.value(QStringLiteral("sessionName")).isString()
                && !entry.value(QStringLiteral("type")).isString()) {
                continue;
            }
            const QString id = entry.value(QStringLiteral("id")).toString();
            if (!id.isEmpty()) {
                ids.insert(id);
                lastId = id;
            }
        }
        keptLines.append(line);
    }
    QString id = QUuid::createUuid().toString(QUuid::Id128).left(8);
    while (ids.contains(id)) id = QUuid::createUuid().toString(QUuid::Id128).left(8);
    QJsonObject entry{
        {QStringLiteral("type"), QStringLiteral("session_info")},
        {QStringLiteral("id"), id},
        {QStringLiteral("parentId"), lastId.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(lastId)},
        {QStringLiteral("timestamp"), QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)},
        {QStringLiteral("name"), sanitized},
    };
    for (auto iterator = extra.constBegin(); iterator != extra.constEnd(); ++iterator) {
        entry.insert(iterator.key(), iterator.value());
    }
    keptLines.append(QString::fromUtf8(QJsonDocument(entry).toJson(QJsonDocument::Compact)));
    return keptLines.join(QLatin1Char('\n')) + QLatin1Char('\n');
}

void SessionScanner::rename(const QString &filePath, const QString &newName) const
{
    const QString raw = readSessionRawText(filePath);
    const QString output = appendSessionInfoLine(raw, newName);
    QString error;
    // Atomic replace: a plain truncate+write would leave half a session if it crashed.
    if (!fs().writeAtomic(filePath, output, &error)) throw ChannelError(error);
}

bool SessionScanner::repairCorruptSessionHeader(const QString &filePath) const
{
    QString head;
    QString error;
    if (!fs().readHead(filePath, 4096, &head, &error)) return false;

    // Mode 1: legacy private header line on the first record.
    bool hasLegacy = false;
    for (const QString &rawLine : head.split(QLatin1Char('\n'))) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty()) continue;
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        if (document.isObject()) {
            const QJsonObject entry = document.object();
            hasLegacy = entry.value(QStringLiteral("sessionName")).isString()
                && !entry.value(QStringLiteral("type")).isString();
        }
        break;
    }
    if (hasLegacy) {
        const QString raw = readSessionRawText(filePath);
        QStringList kept;
        for (const QString &rawLine : raw.split(QLatin1Char('\n'))) {
            const QString line = rawLine.trimmed();
            if (line.isEmpty()) continue;
            const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
            if (document.isObject()) {
                const QJsonObject entry = document.object();
                if (entry.value(QStringLiteral("sessionName")).isString()
                    && !entry.value(QStringLiteral("type")).isString()) {
                    continue;
                }
            }
            kept.append(line);
        }
        const QString stripped = kept.isEmpty() ? QString() : kept.join(QLatin1Char('\n')) + QLatin1Char('\n');
        if (stripped == raw) return false;
        if (!fs().writeAtomic(filePath, stripped, &error)) throw ChannelError(error);
        return true;
    }

    // Mode 2: `<path>.jsonl{...}` glued onto the header with no newline. pi skips the
    // unparseable first line and then rejects the file because entry 0 is not `session`.
    const int newline = head.indexOf(QLatin1Char('\n'));
    const QString firstLine = newline < 0 ? head : head.left(newline);
    const int marker = firstLine.indexOf(QStringLiteral(".jsonl{"));
    if (marker < 0) return false;
    const QString candidate = firstLine.mid(marker + 6);
    const QJsonDocument document = QJsonDocument::fromJson(candidate.toUtf8());
    if (!document.isObject()) return false;
    const QJsonObject parsed = document.object();
    if (parsed.value(QStringLiteral("type")).toString() != QLatin1String("session")
        || !parsed.value(QStringLiteral("id")).isString()) {
        return false;
    }
    const QString raw = readSessionRawText(filePath);
    QStringList lines = raw.split(QLatin1Char('\n'));
    if (lines.isEmpty()) return false;
    if (lines.first() == candidate) return false;
    lines[0] = candidate;
    if (!fs().writeAtomic(filePath, lines.join(QLatin1Char('\n')), &error)) throw ChannelError(error);
    return true;
}

QString SessionScanner::nextCopyPath(const QString &filePath) const
{
    const QString directory = fs().dirname(filePath);
    const QString stem = fs().stem(filePath);
    for (int index = 1; index < 1000; ++index) {
        const QString suffix = index == 1 ? QStringLiteral("copy") : QStringLiteral("copy-%1").arg(index);
        const QString candidate = fs().join(directory, QStringLiteral("%1-%2.jsonl").arg(stem, suffix));
        // WSL existence checks are expensive; the unique temp+rename below still
        // guarantees no overwrite, so the check is native-only.
        if (fs().wsl() || !fs().exists(candidate)) return candidate;
    }
    throw ChannelError(QStringLiteral("Unable to allocate a unique session copy name"));
}

SessionSummary SessionScanner::copy(const QString &filePath) const
{
    const QString raw = readSessionRawText(filePath);
    summaryreader::Context context;
    context.fs = fs();
    context.scanRoots = activeScanRoots();
    context.translate = m_translate;
    context.hostHome = m_config.hostHome;
    qint64 mtimeMs = 0;
    qint64 size = 0;
    fs().statVersion(filePath, &mtimeMs, &size);
    const summaryreader::Result current = summaryreader::read(filePath, raw, mtimeMs, context);
    const QString title = current.isSession && !current.summary.name.isEmpty()
        ? current.summary.name
        : m_translate(QStringLiteral("session.untitled"), QJsonObject{});
    const QString targetPath = nextCopyPath(filePath);
    const QString content = appendSessionInfoLine(
        raw, m_translate(QStringLiteral("session.copyTitle"), QJsonObject{{QStringLiteral("title"), title}}),
        QJsonObject{{QStringLiteral("copiedFrom"), filePath}});
    QString error;
    const QString temp = targetPath + QStringLiteral(".") + QUuid::createUuid().toString(QUuid::Id128)
        + QStringLiteral(".tmp");
    if (!fs().writeAtomic(temp, content, &error)) throw ChannelError(error);
    if (!fs().moveNoClobber(temp, targetPath, &error)) {
        fs().removeFile(temp);
        throw ChannelError(error);
    }
    qint64 copyMtime = 0;
    qint64 copySize = 0;
    fs().statVersion(targetPath, &copyMtime, &copySize);
    const summaryreader::Result copied = summaryreader::read(targetPath, content, copyMtime, context);
    if (!copied.isSession) throw ChannelError(QStringLiteral("Unable to read the copied session file"));
    return copied.summary;
}

QJsonObject SessionScanner::exportHtml(const QString &filePath) const
{
    const QString raw = readSessionRawText(filePath);
    summaryreader::Context context;
    context.fs = fs();
    context.scanRoots = activeScanRoots();
    context.translate = m_translate;
    context.hostHome = m_config.hostHome;
    qint64 mtimeMs = 0;
    qint64 size = 0;
    fs().statVersion(filePath, &mtimeMs, &size);
    const summaryreader::Result summary = summaryreader::read(filePath, raw, mtimeMs, context);
    if (!summary.isSession) throw ChannelError(QStringLiteral("Unable to read the session file"));

    const auto escape = [](const QString &value) {
        QString text = value;
        text.replace(QLatin1Char('&'), QStringLiteral("&amp;"));
        text.replace(QLatin1Char('<'), QStringLiteral("&lt;"));
        text.replace(QLatin1Char('>'), QStringLiteral("&gt;"));
        text.replace(QLatin1Char('"'), QStringLiteral("&quot;"));
        return text;
    };

    QStringList rows;
    for (const QString &rawLine : raw.split(QLatin1Char('\n'))) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty()) continue;
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        if (!document.isObject()) continue;
        const QJsonObject entry = document.object();
        // Visible goal/guidance cards are read-only turns; hidden task rules never ship in
        // an export, and a bare custom message is not part of the conversation.
        pitask::TaskMessage task;
        if (pitask::readTodoTaskMessage(QJsonValue(entry), &task)) {
            const QString label = m_translate(task.kind == pitask::Kind::Goal
                                                  ? QStringLiteral("session.todoGoal")
                                                  : QStringLiteral("session.todoGuidance"),
                                              QJsonObject{});
            rows.append(QStringLiteral("<section class=\"msg system\"><h2>%1</h2><pre>%2</pre></section>")
                            .arg(escape(label), escape(task.text)));
            continue;
        }
        if (entry.value(QStringLiteral("type")).toString() == QLatin1String("custom_message")) continue;
        QJsonValue messageValue = entry.value(QStringLiteral("message"));
        if (messageValue.isUndefined()) {
            messageValue = entry.value(QStringLiteral("data")).toObject().value(QStringLiteral("message"));
        }
        if (messageValue.isUndefined()) messageValue = QJsonValue(entry);
        if (!messageValue.isObject()) continue;
        const QJsonObject message = messageValue.toObject();
        const QString role = message.value(QStringLiteral("role")).toString();
        if (role.isEmpty()) continue;
        const QString text = messagecontent::extractMessageText(message.value(QStringLiteral("content"))).trimmed();
        if (text.isEmpty()) continue;
        rows.append(QStringLiteral("<section class=\"msg %1\"><h2>%1</h2><pre>%2</pre></section>")
                        .arg(escape(role), escape(text)));
    }
    const QString title = summary.summary.name.isEmpty()
        ? m_translate(QStringLiteral("session.untitled"), QJsonObject{})
        : summary.summary.name;
    const QString html = QStringLiteral(
                             "<!doctype html><html><head><meta charset=\"utf-8\"><title>%1</title>"
                             "<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;"
                             "max-width:920px;margin:32px auto;padding:0 20px;color:#1f2937}"
                             ".msg{border:1px solid #e5e7eb;border-radius:10px;padding:14px;"
                             "margin:12px 0;background:#fff}.msg h2{margin:0 0 8px;font-size:13px;"
                             "color:#64748b}.msg pre{white-space:pre-wrap;margin:0;"
                             "font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}"
                             "</style></head><body><h1>%1</h1><p>%2 · %3 messages</p>%4</body></html>")
                             .arg(escape(title),
                                  QDateTime::fromMSecsSinceEpoch(summary.summary.updatedAt).toString(Qt::ISODate),
                                  QString::number(summary.summary.messageCount), rows.join(QLatin1Char('\n')));
    QString safeName = title;
    safeName.replace(QRegularExpression(QStringLiteral("[\\\\/:*?\"<>|]")), QStringLiteral("_"));
    safeName = safeName.left(80);
    if (safeName.isEmpty()) safeName = QStringLiteral("session");
    const QString targetPath = QDir(m_config.downloadsDir)
                                   .filePath(QStringLiteral("%1-%2.html")
                                                 .arg(safeName)
                                                 .arg(QDateTime::currentMSecsSinceEpoch()));
    QString error;
    if (!sessionfiles::writeAtomic(targetPath, html.toUtf8(), &error)) throw ChannelError(error);
    return QJsonObject{{QStringLiteral("path"), targetPath}};
}
