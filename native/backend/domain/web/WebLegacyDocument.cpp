#include "WebLegacyDocument.h"

namespace weblegacy {
namespace {

/**
 * Everything the browser receives before the dictionaries JSON.
 *
 * Kept as raw literals so no escape processing can drift from the oracle: the text
 * below is exactly what the TS template emits (tabs, `\n`, `\{` …).
 */
constexpr char kPrefix[] =
    R"PIDECKLEGACY(<!doctype html>
<html lang="en-US">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>PiDeck-Q Web Service</title>
	<style>
		:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		body { margin: 0; background: #f4f6f8; color: #252a31; }
		.app { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100vh; }
		aside { border-right: 1px solid #dfe5ee; background: #fff; padding: 16px; overflow: auto; }
		main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
		header { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 18px; border-bottom: 1px solid #dfe5ee; background: #fff; }
		h1 { margin: 0; font-size: 16px; }
		.status { font-size: 12px; color: #687280; }
		.list { display: grid; gap: 8px; }
		button { border: 1px solid #d7dce4; background: #fff; border-radius: 8px; padding: 8px 10px; color: #252a31; cursor: pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease, opacity .12s ease; }
		button:hover:not(:disabled) { transform: translateY(-1px); border-color: #b8c2d0; }
		button.primary { border-color: #14a514; background: #14a514; color: #fff; min-width: 88px; font-weight: 700; }
		button.primary:hover:not(:disabled) { background: #129212; border-color: #129212; }
		button.danger { color: #d93025; border-color: #f1b9b9; background: #fff7f7; }
		button.ghost { color: #687280; background: #f8fafc; }
		.header-actions { display: flex; align-items: center; gap: 8px; }
		.header-actions button { height: 34px; padding: 0 12px; }
		button:disabled { opacity: .6; cursor: not-allowed; }
		.item { text-align: left; display: grid; gap: 3px; min-width: 0; }
		.item.loading { border-color: #14a514; background: #f0fdf4; }
		.item.active { border-color: #14a514; box-shadow: 0 0 0 2px rgba(20,165,20,.12); }
		.item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.item small { color: #687280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.section-title { margin: 18px 0 8px; color: #687280; font-size: 12px; font-weight: 700; }
		.session-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: stretch; }
		.close-session { padding: 0 10px; font-size: 12px; }
		.messages { overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
		.message { max-width: min(820px, 88%); border: 1px solid #dfe5ee; background: #fff; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; line-height: 1.55; }
		.message.user { align-self: flex-end; background: #eaf8ee; border-color: #bee8c6; }
		.message.error { border-color: #ffd0d0; background: #fff4f4; color: #b42318; }
		.message.streaming { border-color: #c3d5f0; background: #f7fafd; }
		.role { display: block; margin-bottom: 4px; font-size: 11px; font-weight: 700; color: #687280; }
		.streaming-thinking { margin: 6px 0; padding: 6px 10px; border-left: 3px solid #b8c2d0; background: #f1f4f8; color: #687280; font-size: 12px; white-space: pre-wrap; line-height: 1.5; }
		.streaming-tool { margin: 6px 0; padding: 6px 10px; border: 1px solid #dfe5ee; border-radius: 6px; background: #fbfcfe; font-size: 12px; color: #46505e; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
		.streaming-tool .tool-name { font-weight: 700; color: #14a514; }
		.streaming-tool.error .tool-name { color: #d93025; }
		.caret { display: inline-block; width: 7px; height: 14px; margin-left: 2px; vertical-align: -2px; background: #14a514; animation: blink 1s steps(2) infinite; }
		@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
		.composer { display: grid; gap: 8px; padding: 12px; border-top: 1px solid #dfe5ee; background: #fff; })PIDECKLEGACY"
    R"PIDECKLEGACY(
		.composer-box { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; border: 1px solid #d7dce4; border-radius: 10px; padding: 8px; background: #fff; }
		textarea { width: 100%; min-height: 44px; max-height: 160px; resize: vertical; border: 0; outline: 0; padding: 6px 8px; font: inherit; line-height: 1.5; }
		.composer-actions { display: flex; align-items: center; gap: 8px; }
		.composer-hint { color: #8a94a6; font-size: 12px; padding-left: 4px; }
		.empty { margin: auto; color: #687280; text-align: center; }
		.pulse { display: inline-flex; width: 8px; height: 8px; border-radius: 999px; background: #14a514; animation: pulse 1s infinite ease-in-out; margin-right: 6px; }
		@keyframes pulse { 0%, 100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
		@media (max-width: 760px) { .app { grid-template-columns: 1fr; } aside { max-height: 42vh; border-right: 0; border-bottom: 1px solid #dfe5ee; } }
	</style>
</head>
<body>
	<div class="app">
		<aside>
			<h1>PiDeck-Q</h1>
			<div id="projects-title" class="section-title"></div>
			<div id="projects" class="list"></div>
			<div id="sessions-title" class="section-title"></div>
			<div id="sessions" class="list"></div>
		</aside>
		<main>
			<header>
				<h1 id="title"></h1>
				<div class="header-actions">
					<span id="status" class="status"></span>
					<button class="danger" type="button" id="stop"></button>
				</div>
			</header>
			<div id="messages" class="messages"></div>
			<form id="composer" class="composer">
				<div class="composer-box">
					<textarea id="prompt"></textarea>
					<div class="composer-actions">
						<button class="primary" type="submit" id="submit"></button>
					</div>
				</div>
				<div id="composer-hint" class="composer-hint"></div>
			</form>
		</main>
	</div>
	<script>
		const dictionaries = )PIDECKLEGACY";;

} // namespace

QByteArray documentPrefix()
{
    return QByteArray(kPrefix, int(sizeof(kPrefix) - 1));
}

} // namespace weblegacy
