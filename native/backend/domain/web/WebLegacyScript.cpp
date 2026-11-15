#include "WebLegacyDocument.h"

namespace weblegacy {
namespace {

/**
 * The client script and the document tail, i.e. everything after the dictionaries
 * JSON. Verbatim for the same reason as `kPrefix` in WebLegacyDocument.cpp.
 */
constexpr char kSuffix[] =
    R"PIDECKLEGACY(;
		const locale = /^zh(?:-|$)/i.test(navigator.languages?.[0] || navigator.language || "") ? "zh-CN" : "en-US";
		const copy = dictionaries[locale] || dictionaries["en-US"];
		let state = { projects: [], sessions: [], runtimes: [], messagesBySession: {} };
		let activeSessionId = "";
		let creatingProjectId = "";
		let refreshing = false;
		const el = (id) => document.getElementById(id);
		function tr(key, params) {
			let text = copy[key] || dictionaries["en-US"][key] || key;
			if (!params) return text;
			return text.replace(/\{(\w+)\}/g, (match, name) => params[name] == null ? match : String(params[name]));
		}
		function trOr(key, fallback) {
			return copy[key] || dictionaries["en-US"][key] || fallback;
		}
		function localizeDescriptor(value, fallback) {
			if (!value?.i18nKey || !copy[value.i18nKey]) return fallback;
			return tr(value.i18nKey, value.i18nParams);
		}
		function localizeMessage(message) {
			const localized = localizeDescriptor(message.meta, message.text || "");
			const debug = typeof message.meta?.debugDetails === "string" ? message.meta.debugDetails.trim() : "";
			if (debug) console.error(debug);
			return localized;
		}
		function runtimeFor(sessionId) {
			return state.runtimes.find(runtime => runtime.sessionId === sessionId);
		}
		function runtimeTarget(runtime) {
			return runtime ? {
				sessionId: runtime.sessionId,
				agentId: runtime.agentId,
				runtimeGeneration: runtime.runtimeGeneration,
			} : undefined;
		}
		function displayStatus(session, runtime) {
			return trOr("web.status." + (runtime?.status || session?.status || "unknown"), tr("web.status.unknown"));
		}
		function mergeRejectedDraft(rejected, current) {
			return [rejected, current].filter(value => value && value.trim()).join("\n\n");
		}
		function applyStaticCopy() {
			document.documentElement.lang = locale;
			el("projects-title").textContent = tr("web.projects");
			el("sessions-title").textContent = tr("web.sessions");
			el("title").textContent = tr("web.chooseSession");
			el("status").textContent = tr("web.connecting");
			el("stop").textContent = tr("web.closeSession");
			el("messages").innerHTML = '<div class="empty">' + escapeHtml(tr("web.emptySelection")) + '</div>';
			el("prompt").placeholder = tr("web.promptPlaceholder");
			el("submit").textContent = tr("web.send");
			el("composer-hint").textContent = tr("web.composerHint");
		}
		async function api(path, options) {
			const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
			if (!res.ok) {
				const payload = await res.json().catch(() => ({}));
				if (payload.debugDetails) console.error(payload.debugDetails);
				throw new Error(payload.code ? tr(payload.code, payload.params) : (payload.error || res.statusText));
			}
			return res.json();
		}
		async function loadSessionMessages(sessionId) {
			const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages/page`);
			state.messagesBySession = { ...state.messagesBySession, [sessionId]: response.messages || [] };
		}
		async function refresh() {
			if (refreshing) return;
			refreshing = true;
			try {
				// 合并旧 messagesBySession：运行时消息缓存被标 stale（如历史修改提交后刷新失败）时
				// /api/state 会省略该会话 key，直接整体替换会把已有消息误显示为空会话；
				// 正常 snapshot 仍覆盖旧值，会话删除由下方 sessions 校验兜底。
				const previousMessagesBySession = state.messagesBySession;
				const next = await api("/api/state");
				state = {
					...next,
					messagesBySession: {
						...previousMessagesBySession,
						...next.messagesBySession,
					},
				};
				if (!state.sessions.some(session => session.id === activeSessionId)) {
					activeSessionId = state.sessions[0]?.id || "";
				}
				el("status").textContent = tr("web.connected");
				// 流式期间保留 #messages 的实时打字机内容；仅刷新侧栏/状态，)PIDECKLEGACY"
    R"PIDECKLEGACY(
				// 避免 600ms 轮询的全量 innerHTML 重绘清掉正在流式的块。
				if (streamingSessionId) {
					render();
				} else {
					render();
					renderMessages();
				}
			} catch (error) {
				el("status").textContent = error.message || String(error);
			} finally {
				refreshing = false;
			}
		}
		function render() {
			el("projects").innerHTML = state.projects.map(project => `
				<button class="item ${project.id === creatingProjectId ? "loading" : ""}" data-project="${project.id}" ${creatingProjectId ? "disabled" : ""}>
					<strong>${escapeHtml(project.name)}</strong>
					<small>${project.id === creatingProjectId ? '<span class="pulse"></span>' + escapeHtml(tr("web.opening")) : escapeHtml(project.path)}</small>
				</button>`).join("");
			el("sessions").innerHTML = state.sessions.map(session => {
				const runtime = runtimeFor(session.id);
				const project = state.projects.find(item => item.id === session.projectId);
				return `<div class="session-row">
					<button class="item ${session.id === activeSessionId ? "active" : ""}" data-session="${session.id}">
						<strong>${escapeHtml(session.title)}</strong>
						<small>${runtime?.status === "running" ? '<span class="pulse"></span>' : ""}${escapeHtml(displayStatus(session, runtime))} · ${escapeHtml(runtime?.cwd || session.projectPath || project?.path || "")}</small>
					</button>
					<button class="close-session ghost" data-close-session="${session.id}" title="${escapeHtml(tr("web.closeSession"))}" ${runtime ? "" : "disabled"}>${escapeHtml(tr("web.closeSession"))}</button>
				</div>`;
			}).join("");
			const session = state.sessions.find(item => item.id === activeSessionId);
			const runtime = session ? runtimeFor(session.id) : undefined;
			el("title").textContent = session ? session.title : tr("web.chooseSession");
			el("status").innerHTML = runtime?.status === "running"
				? '<span class="pulse"></span>' + escapeHtml(tr("web.responding"))
				: (session ? escapeHtml(displayStatus(session, runtime)) : escapeHtml(tr("web.connected")));
			el("prompt").disabled = !session;
			el("composer").querySelector("button[type=submit]").disabled = !session;
			el("stop").disabled = !runtime || runtime.status === "closed";
			el("stop").textContent = runtime?.status === "running" ? tr("web.stopResponse") : tr("web.closeSession");
		}
		function renderMessages() {
			const messages = activeSessionId ? state.messagesBySession[activeSessionId] || [] : [];
			el("messages").innerHTML = messages.length
				? messages.map(message => `<div class="message ${message.role}"><span class="role">${escapeHtml(trOr("web.role." + message.role, message.role))}</span>${escapeHtml(localizeMessage(message))}</div>`).join("")
				: '<div class="empty">' + escapeHtml(tr("web.noMessages")) + '</div>';
		}
		document.addEventListener("click", async (event) => {
			const closeButton = event.target.closest("[data-close-session]");
			if (closeButton) {
				const sessionId = closeButton.dataset.closeSession;
				const runtime = runtimeFor(sessionId);
				if (!runtime) return;
				closeButton.disabled = true;
				closeButton.textContent = tr("web.closing");
				try {
					const action = runtime.status === "running" ? "abort" : "stop";
					await api(`/api/sessions/${encodeURIComponent(sessionId)}/runtime/${action}`, {
						method: "POST",
						body: JSON.stringify({ target: runtimeTarget(runtime) }),
					});
					await refresh();
				} finally {
					closeButton.disabled = false;
					closeButton.textContent = tr("web.closeSession");
				}
				return;
			}
			const projectButton = event.target.closest("[data-project]");
			if (projectButton) {
				creatingProjectId = projectButton.dataset.project;
				render();
				try {
					const result = await api("/api/sessions", { method: "POST", body: JSON.stringify({ projectId: projectButton.dataset.project }) });
					activeSessionId = result.session.id;
					await refresh();
				} finally {
					creatingProjectId = "";
					render();)PIDECKLEGACY"
    R"PIDECKLEGACY(
				}
				return;
			}
			const sessionButton = event.target.closest("[data-session]");
			if (sessionButton) {
				// 切换会话：终止上一个 SSE 流，避免流式块串到别的会话
				stopStream();
				activeSessionId = sessionButton.dataset.session;
				if (!Object.hasOwn(state.messagesBySession, activeSessionId)) {
					await loadSessionMessages(activeSessionId);
				}
				render();
				return;
			}
		});
		// ── SSE 流式渲染：提交 prompt 后订阅 /stream，实时展示思考/工具/文本（A1） ──
		let streamingSessionId = "";
		let streamAbortController = null;
		let streamBlocks = { message: null, thinking: null, text: null, tools: [] };

		function ensureStreamingMessage() {
			if (streamBlocks.message) return streamBlocks.message;
			const messages = el("messages");
			// 清空空态占位（"请选择会话/暂无消息"）后再追加流式块
			const empty = messages.querySelector(".empty");
			if (empty) empty.remove();
			const div = document.createElement("div");
			div.className = "message streaming";
			div.innerHTML = '<span class="role">' + escapeHtml(tr("web.role.assistant")) + '</span>';
			messages.appendChild(div);
			streamBlocks.message = div;
			return div;
		}
		function ensureStreamingThinking() {
			if (streamBlocks.thinking) return streamBlocks.thinking;
			const block = document.createElement("div");
			block.className = "streaming-thinking";
			ensureStreamingMessage().appendChild(block);
			streamBlocks.thinking = block;
			return block;
		}
		function ensureStreamingText() {
			if (streamBlocks.text) return streamBlocks.text;
			const block = document.createElement("div");
			block.className = "streaming-text";
			ensureStreamingMessage().appendChild(block);
			streamBlocks.text = block;
			return block;
		}
		function addToolBlock(name, isError) {
			const block = document.createElement("div");
			block.className = "streaming-tool" + (isError ? " error" : "");
			block.innerHTML = '<span class="tool-name">' + escapeHtml(name) + '</span>' + escapeHtml(" 执行中…");
			ensureStreamingMessage().appendChild(block);
			streamBlocks.tools.push(block);
			return block;
		}
		function scrollStreamToBottom() {
			const messages = el("messages");
			messages.scrollTop = messages.scrollHeight;
		}
		function applyStreamFrame(frame) {
			const type = frame && frame.type;
			if (!type) return;
			if (type === "reasoning-start") {
				ensureStreamingThinking();
				scrollStreamToBottom();
				return;
			}
			if (type === "reasoning-delta") {
				const block = ensureStreamingThinking();
				block.textContent += (frame.delta || "");
				scrollStreamToBottom();
				return;
			}
			if (type === "reasoning-end") {
				scrollStreamToBottom();
				return;
			}
			if (type === "text-start") {
				ensureStreamingText();
				scrollStreamToBottom();
				return;
			}
			if (type === "text-delta") {
				const block = ensureStreamingText();
				block.textContent += (frame.delta || "");
				scrollStreamToBottom();
				return;
			}
			if (type === "text-end") {
				scrollStreamToBottom();
				return;
			}
			if (type === "tool-input-available") {
				const tool = addToolBlock(frame.toolName || "tool", false);
				// 记录工具名供 output 阶段回写（dataset 无法存 JSON 外的富文本，这里直接存）
				tool.dataset.toolName = String(frame.toolName || "tool");
				scrollStreamToBottom();
				return;
			}
			if (type === "tool-output-available") {
				const tool = streamBlocks.tools.pop();
				if (tool) {
					tool.className = "streaming-tool" + (frame.output && frame.output.error ? " error" : "");
					tool.innerHTML = '<span class="tool-name">' + escapeHtml(tool.dataset.toolName || "tool") + '</span>' + escapeHtml(" 完成");
				}
				scrollStreamToBottom();
				return;
			}
			if (type === "error") {
				const block = ensureStreamingText();
				block.textContent += "\n[错误] " + (frame.errorText || "");
				scrollStreamToBottom();
				return;
			})PIDECKLEGACY"
    R"PIDECKLEGACY(
			// finish / start 等由外部统一处理
		}
		async function startStream(sessionId) {
			stopStream();
			streamingSessionId = sessionId;
			streamBlocks = { message: null, thinking: null, text: null, tools: [] };
			streamAbortController = new AbortController();
			try {
				const res = await fetch(
					`/api/sessions/${encodeURIComponent(sessionId)}/stream`,
					{ signal: streamAbortController.signal, headers: { accept: "text/event-stream" } },
				);
				if (!res.ok || !res.body) {
					el("status").textContent = tr("web.streamFailed");
					return;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					// SSE 帧以空行分隔；逐帧解析 data: 行
					let sep;
					while ((sep = buffer.indexOf("\n\n")) !== -1) {
						const rawEvent = buffer.slice(0, sep);
						buffer = buffer.slice(sep + 2);
						const dataLine = rawEvent.split("\n").find(line => line.startsWith("data:"));
						if (!dataLine) continue;
						const payload = dataLine.slice(5).trim();
						if (payload === "[DONE]") {
							// 流结束：先停流（保留已渲染的打字机内容），再拉权威消息列表整体替换，
							// 保证最终展示的是 pi 落盘的完整回复（含被流式块拆分的边界）。
							setTimeout(() => { finishStream(sessionId); }, 0);
							return;
						}
						if (!payload) continue;
						try {
							applyStreamFrame(JSON.parse(payload));
						} catch { /* 忽略无法解析的帧 */ }
					}
				}
				// 流正常结束（无 [DONE]）也同步一次
				if (streamingSessionId === sessionId) { finishStream(sessionId); }
			} catch (error) {
				if (error && error.name === "AbortError") return;
				el("status").textContent = tr("web.streamFailed");
			} finally {
				if (streamingSessionId === sessionId) streamingSessionId = "";
			}
		}
		function stopStream() {
			if (streamAbortController) {
				try { streamAbortController.abort(); } catch {}
				streamAbortController = null;
			}
			streamingSessionId = "";
			streamBlocks = { message: null, thinking: null, text: null, tools: [] };
		}
		async function finishStream(sessionId) {
			stopStream();
			// 拉取权威消息列表（pi 已落盘完整回复）并整体重绘，替换流式时的增量块。
			try {
				await loadSessionMessages(sessionId);
			} catch { /* 历史加载失败则保留流式内容 */ }
			render();
			renderMessages();
		}
		// 切换会话时终止上一个流，避免串台（在 click 委托中调用 stopStream）
		el("composer").addEventListener("submit", async (event) => {
			event.preventDefault();
			const prompt = el("prompt");
			const message = prompt.value.trim();
			if (!message || !activeSessionId) return;
			const targetSessionId = activeSessionId;
			prompt.value = "";
			try {
				const response = await api(`/api/sessions/${encodeURIComponent(targetSessionId)}/prompt`, {
					method: "POST",
					body: JSON.stringify({ requestId: crypto.randomUUID(), message }),
				});
				if (!response.result.accepted) {
					if (response.result.delivery !== "unknown" && activeSessionId === targetSessionId) {
						prompt.value = mergeRejectedDraft(message, prompt.value);
					}
					el("status").textContent = localizeDescriptor(response.result, response.result.error);
					return;
				}
				// 已接受：立刻打开 SSE 订阅该会话的流式事件；
				// 流结束后（agent_end → [DONE]）再 refresh() 同步权威消息列表。
				if (activeSessionId === targetSessionId) {
					void startStream(targetSessionId);
				} else {
					// 提交后切走了会话，仍要拉一次最新消息
					await refresh();
				}
			} catch (error) {
				// Transport errors are indeterminate after the request leaves the browser.)PIDECKLEGACY"
    R"PIDECKLEGACY(
				// Never restore automatically because the Session may already have accepted it.
				el("status").textContent = error.message || String(error);
				console.error(error);
			}
		});
		el("prompt").addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			el("composer").requestSubmit();
		});
		el("stop").addEventListener("click", async () => {
			if (!activeSessionId) return;
			const runtime = runtimeFor(activeSessionId);
			if (!runtime) return;
			el("stop").disabled = true;
			el("stop").textContent = tr("web.processing");
			try {
				const action = runtime.status === "running" ? "abort" : "stop";
				await api(`/api/sessions/${encodeURIComponent(activeSessionId)}/runtime/${action}`, {
					method: "POST",
					body: JSON.stringify({ target: runtimeTarget(runtime) }),
				});
				await refresh();
			} finally {
				el("stop").textContent = tr("web.closeSession");
			}
		});
		function escapeHtml(value) {
			return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
		}
		applyStaticCopy();
		refresh();
		setInterval(refresh, 600);
	</script>
</body>
</html>)PIDECKLEGACY";;

} // namespace

QByteArray documentSuffix()
{
    return QByteArray(kSuffix, int(sizeof(kSuffix) - 1));
}

} // namespace weblegacy
