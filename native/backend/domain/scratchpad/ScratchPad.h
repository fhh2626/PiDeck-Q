#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

/**
 * Scratch-pad drafts (`<userData>/drafts/*.md`).
 *
 * Port of src/main/ipc/scratchPadIpc.ts. A draft is just a markdown file; the store owns
 * the legacy `scratch-pad.md` migration, the file naming convention and the recycle-bin
 * deletion so the channel layer stays a thin adapter.
 */
namespace scratchpad {

/** Ensure the drafts directory exists and migrate the legacy single-file scratch pad. */
void ensureDraftsDir(const QString &userDataDir);

/** `[{id, name, path, createdAt, updatedAt}]`, newest first. */
QJsonArray list(const QString &userDataDir);

/** Create an empty draft named after the current local time. */
QJsonObject create(const QString &userDataDir);

/** `{content, lastEditedAt, cursorPosition}`; an empty path or unreadable file is empty. */
QJsonObject load(const QString &draftPath);

/** Write the draft body; the cursor position is only echoed to the log by the oracle. */
void save(const QString &userDataDir, const QString &draftPath, const QString &content);

/** Absolute path of a draft, or an empty string when the path is missing. */
QString draftPathFor(const QString &draftPath);

/**
 * True when `draftPath` is a file inside `<userData>/drafts`.
 *
 * The oracle writes whatever path it is handed; this backend only ever receives paths it
 * listed itself, so restricting writes to the drafts directory costs no behaviour and
 * keeps an arbitrary-path write out of the IPC surface.
 */
bool insideDrafts(const QString &userDataDir, const QString &draftPath);

} // namespace scratchpad
