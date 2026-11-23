#pragma once

#include <QString>

/**
 * External link protocol gateway.
 *
 * Port of src/main/browser/externalLinks.ts. The renderer (and therefore model output and
 * tool output) can name any URL, so `app:open-external` is an untrusted IPC boundary: it
 * must never forward an arbitrary scheme to the OS handler. `file:`, `search-ms:`,
 * `ms-*` and friends can launch local programs, so only web protocols and a small
 * allowlist of communication / editor deep links are handed to the system.
 *
 * The policy is a pure function so it can be reasoned about without a host bridge.
 */
namespace externallinks {

/** Lower-cased scheme including the trailing ':' (`"https:"`); empty when unparseable. */
QString urlScheme(const QString &url);

/** `http:` / `https:` only. */
bool isHttpLike(const QString &url);

/**
 * True when the URL may leave the application.
 *
 * Allowlist: `http:`, `https:`, `mailto:`, `tel:`, `sms:`, `vscode:`, `vscode-insiders:`.
 * Everything else (including a URL that does not parse) is rejected.
 */
bool isAllowedSystemProtocol(const QString &url);

} // namespace externallinks
