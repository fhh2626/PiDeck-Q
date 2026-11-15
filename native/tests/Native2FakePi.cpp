// Native fake `pi` for the packaged-host acceptance gate (native2).
//
// Why a native executable instead of a `.cmd` shim like
// `tests/fixtures/native2-fake-pi-runtime.mjs`: the packaged C++ product must run a full
// agent turn with **no Node.js on PATH and none in the package at all**. A batch shim
// would need `node`, so it could only prove the flow while a business runtime was present
// — exactly what the de-Node acceptance criterion forbids.
//
// It speaks pi's real stdio protocol (newline-delimited JSON):
//   * argv contains `--version`  -> print the version and exit (the CLI probe path);
//   * `{type:"prompt"}`          -> correlated ack, then a scripted turn;
//   * any other command          -> correlated default response;
//   * `{type:"abort"}`           -> stops the turn and settles.
//
// Multi-turn fidelity matters as much as the single-turn flow: the packaged gate asserts
// that a *second* prompt in the same session produces a second assistant row. So every turn
// owns its own identity (`assistant-N`, `tool-N`, `ask-N`), an ask blocks until *that* ask is
// answered (the latch is reset before the request is published, never shared between
// turns), and one owned worker thread runs the scripted turns while the stdin loop stays
// free to read `extension_ui_response` / `abort` mid-turn.
//
// Deliberately dependency-free (no Qt, no Node): the gate must be able to run it with a
// PATH that holds only the OS directories and the package, so a missing runtime shows up
// as a missing runtime instead of being masked by the test double.
//
// Parsing is intentionally minimal — the only peer is the backend's own serializer, so a
// small field scan is enough. Every received frame and emitted event is appended to
// FAKE_PI_LOG when the gate sets it, which is what the gate asserts against.
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

namespace {

constexpr int kStepDelayMs = 70;

std::mutex g_writeMutex;
std::mutex g_logMutex;
// Pending ask: exactly one question is outstanding at a time, and only an answer carrying
// that id may unblock it. `prepareAsk` resets the state before the request is published, so
// a latched answer from an earlier turn can never let the next ask fall through.
std::mutex g_answerMutex;
std::condition_variable g_answerCondition;
std::string g_pendingAskId;          // guarded by g_answerMutex
bool g_pendingAskAnswered = false;   // guarded by g_answerMutex
// One owned turn worker: the queue holds at most one scripted turn (the backend never
// prompts while a run streams), and shutdown joins it instead of detaching.
std::mutex g_jobMutex;
std::condition_variable g_jobCondition;
std::string g_jobText;               // guarded by g_jobMutex
bool g_jobPending = false;           // guarded by g_jobMutex
std::atomic_bool g_shutdown{false};
std::atomic_bool g_aborted{false};
std::atomic_bool g_streaming{false};
std::atomic_int g_turnIndex{0};
// Runtime state the backend reads back through `get_state`. `set_model` /
// `set_thinking_level` must be honoured like real pi: a fake that keeps reporting its
// hard-coded default makes the renderer believe its selection never applied and restart
// the runtime in a loop.
std::mutex g_stateMutex;
std::string g_modelProvider = "anthropic";
std::string g_modelId = "claude-sonnet-4";
std::string g_thinkingLevel = "high";
std::string g_logPath;

void appendLog(const std::string &line)
{
    if (g_logPath.empty()) return;
    // The stdin loop and the turn worker both log; serialize whole lines so concurrent
    // appends cannot interleave inside a JSON frame.
    const std::lock_guard<std::mutex> lock(g_logMutex);
    std::FILE *file = std::fopen(g_logPath.c_str(), "ab");
    if (!file) return;
    std::fwrite(line.data(), 1, line.size(), file);
    std::fputc('\n', file);
    std::fclose(file);
}

void writeRaw(const std::string &line)
{
    appendLog("{\"kind\":\"write\",\"line\":\"" + line.substr(0, 160) + "\"}");
    const std::lock_guard<std::mutex> lock(g_writeMutex);
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

void emitEvent(const std::string &event)
{
    writeRaw(event);
    appendLog("{\"kind\":\"event\",\"event\":" + event + "}");
}

void respond(const std::string &id, const std::string &command, const std::string &data = "{}")
{
    writeRaw("{\"id\":" + id + ",\"type\":\"response\",\"command\":\"" + command +
             "\",\"success\":true,\"data\":" + data + "}");
}

void sleepStep()
{
    std::this_thread::sleep_for(std::chrono::milliseconds(kStepDelayMs));
}

/**
 * Value of a top-level `"key":<raw>` field. `keepQuotes` keeps the JSON quotes for
 * string values, which is what the `id` echo needs: `"id":2bbdb12d-...` is not JSON, so a
 * raw-unquoted echo makes the backend drop every response.
 */
std::string fieldRaw(const std::string &line, const std::string &key, bool keepQuotes = false)
{
    const std::string needle = "\"" + key + "\":";
    std::string::size_type at = line.find(needle);
    if (at == std::string::npos) return {};
    at += needle.size();
    while (at < line.size() && line[at] == ' ') ++at;
    if (at >= line.size()) return {};
    if (line[at] == '"') {
        std::string value;
        for (std::string::size_type index = at + 1; index < line.size(); ++index) {
            if (line[index] == '\\' && index + 1 < line.size()) {
                value.push_back(line[index]);
                value.push_back(line[++index]);
                continue;
            }
            if (line[index] == '"') return keepQuotes ? "\"" + value + "\"" : value;
            value.push_back(line[index]);
        }
        return keepQuotes ? "\"" + value + "\"" : value;
    }
    // Raw scalar / object / array: balance braces so a nested value cannot leak out.
    std::string::size_type end = at;
    int depth = 0;
    for (; end < line.size(); ++end) {
        const char c = line[end];
        if (c == '{' || c == '[') ++depth;
        else if (c == '}' || c == ']') {
            if (depth == 0) break;
            --depth;
        } else if (c == ',' && depth == 0) break;
    }
    return line.substr(at, end - at);
}

std::string joinedLog(const std::string &kind, const std::string &payload)
{
    return "{\"kind\":\"" + kind + "\"," + payload + "}";
}

void emitUpdate(const std::string &kind, const std::string &delta)
{
    emitEvent("{\"type\":\"message_update\",\"message\":{\"role\":\"assistant\",\"content\":[]},"
              "\"assistantMessageEvent\":{\"type\":\"" + kind + "\",\"delta\":\"" + delta + "\"}}");
}

/**
 * Stream `text` word by word. The desktop renders the announcing message as a live interim
 * until the tool call closes it, and real pi streams text for seconds; a single burst left the
 * packaged gate almost no window to sample the live row.
 */
void emitTextChunks(const std::string &text)
{
    std::string::size_type start = 0;
    while (start < text.size()) {
        std::string::size_type end = text.find(' ', start);
        end = end == std::string::npos ? text.size() : end + 1;
        emitUpdate("text_delta", text.substr(start, end - start));
        sleepStep();
        start = end;
    }
}

/**
 * Per-process disambiguator. The runtime can be replaced between prompts (pi is restarted),
 * and a plain sequence would then hand the same id to two different messages. Real pi uses
 * unique ids, and a test double that repeats one makes distinct turns collide.
 */
const std::string kProcessNonce = std::to_string(
    static_cast<unsigned long long>(std::chrono::steady_clock::now().time_since_epoch().count()));

std::string turnId(const char *kind, int sequence)
{
    return std::string(kind) + "-" + kProcessNonce + "-" + std::to_string(sequence);
}

/**
 * Optional per-prompt label: `marker:<label>` in the prompt text. The gate labels its prompts
 * so each turn's body is identifiable, which keeps the assertions valid even when the
 * runtime is torn down and restarted between two prompts (the counter resets, the label
 * does not). Unlabelled prompts keep the original single-turn strings.
 */
std::string markerLabel(const std::string &promptText)
{
    const std::string key = "marker:";
    const std::string::size_type at = promptText.find(key);
    if (at == std::string::npos) return {};
    std::string label;
    for (std::string::size_type index = at + key.size(); index < promptText.size(); ++index) {
        const char c = promptText[index];
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') label.push_back(c);
        else break;
    }
    return label;
}

/**
 * Reset the outstanding-ask state for `askId`. Must run **before** the request frame is
 * published: the renderer answers as soon as it sees the card, and a shared/latched flag
 * would let turn N+1 proceed without ever waiting for its own question.
 */
void prepareAsk(const std::string &askId)
{
    const std::lock_guard<std::mutex> lock(g_answerMutex);
    g_pendingAskId = askId;
    g_pendingAskAnswered = false;
}

/** Block until this ask is answered; abort or stdin/EOF shutdown unblock it too. */
bool waitForAskAnswer()
{
    std::unique_lock<std::mutex> lock(g_answerMutex);
    g_answerCondition.wait_for(lock, std::chrono::seconds(30),
                               [] { return g_pendingAskAnswered || g_aborted.load() || g_shutdown.load(); });
    const bool answered = g_pendingAskAnswered;
    g_pendingAskId.clear();
    g_pendingAskAnswered = false;
    return answered;
}

/** Long-streaming turn, so the gate can prove the user stop path through the real UI. */
void runAbortableTurn(int sequence)
{
    emitEvent("{\"type\":\"agent_start\"}");
    // `message_start` is what creates the assistant row in the desktop transcript; without
    // it the deltas below would be dropped by the same guard the oracle has.
    emitEvent("{\"type\":\"message_start\",\"message\":{\"id\":\"" + turnId("assistant", sequence) +
              "\",\"role\":\"assistant\",\"content\":[]}}");
    for (int index = 0; index < 60 && !g_aborted.load() && !g_shutdown.load(); ++index) {
        emitUpdate("text_delta", "streaming chunk " + std::to_string(index) + " ");
        sleepStep();
    }
    if (!g_aborted.load() && !g_shutdown.load()) {
        emitEvent("{\"type\":\"agent_end\",\"messages\":[]}");
        emitEvent("{\"type\":\"agent_settled\"}");
    }
}

/** thinking -> announcing text -> tool call -> interactive question -> final reply -> settled. */
void runStandardTurn(const std::string &label, int sequence)
{
    const std::string messageId = turnId("assistant", sequence);
    const std::string toolId = turnId("tool", sequence);
    const std::string askId = turnId("ask", sequence);
    const std::string finalMessageId = messageId + "-final";
    const bool labelled = !label.empty();
    // Turn 1 (unlabelled) keeps the original strings the single-turn gate pins; a labelled
    // turn carries its own marker so two turns in one session are distinguishable by body.
    const std::string firstChunk = labelled ? "Reply for marker:" + label + " " : "Hello from the ";
    const std::string secondChunk = labelled ? "from the packaged host." : "packaged host.";
    const std::string announceText = firstChunk + secondChunk;
    const std::string finalText = labelled ? "Done with marker:" + label + "." : "Deploying now.";
    const std::string title = labelled ? "Deploy target? (marker:" + label + ")" : "Deploy target?";
    const std::string command = labelled ? "echo marker:" + label : "echo turn-1";

    emitEvent("{\"type\":\"agent_start\"}");
    sleepStep();
    emitEvent("{\"type\":\"message_start\",\"message\":{\"id\":\"" + messageId + "\",\"role\":\"assistant\","
              "\"content\":[]}}");
    // Two thinking deltas and no `thinking_end`: the renderer owns the segment close.
    emitUpdate("thinking_delta", "planning the ");
    sleepStep();
    emitUpdate("thinking_delta", "answer");
    sleepStep();
    emitTextChunks(announceText);
    emitEvent("{\"type\":\"message_end\",\"message\":{\"id\":\"" + messageId + "\",\"role\":\"assistant\","
              "\"content\":[{\"type\":\"text\",\"text\":\"" + announceText + "\"}],"
              "\"stopReason\":\"toolUse\"}}");
    sleepStep();
    emitEvent("{\"type\":\"tool_execution_start\",\"toolName\":\"bash\",\"toolCallId\":\"" + toolId +
              "\",\"args\":{\"command\":\"" + command + "\"}}");
    sleepStep();
    emitEvent("{\"type\":\"tool_execution_end\",\"toolName\":\"bash\",\"toolCallId\":\"" + toolId +
              "\",\"isError\":false}");
    sleepStep();
    prepareAsk(askId);
    emitEvent("{\"type\":\"extension_ui_request\",\"id\":\"" + askId + "\",\"method\":\"input\","
              "\"title\":\"" + title + "\",\"placeholder\":\"staging\"}");
    // A user stop during the question must not hang the fake: waitForAskAnswer also wakes on
    // abort/EOF, and a turn that was cut short must not emit a completion frame.
    if (!waitForAskAnswer()) return;
    // The reply after the tool result is its own assistant message — that is the row the
    // desktop transcript shows permanently once the run settles.
    emitEvent("{\"type\":\"message_start\",\"message\":{\"id\":\"" + finalMessageId + "\",\"role\":\"assistant\","
              "\"content\":[]}}");
    emitUpdate("text_delta", finalText);
    sleepStep();
    emitEvent("{\"type\":\"message_end\",\"message\":{\"id\":\"" + finalMessageId + "\",\"role\":\"assistant\","
              "\"content\":[{\"type\":\"text\",\"text\":\"" + finalText + "\"}],"
              "\"stopReason\":\"stop\"}}");
    sleepStep();
    emitEvent("{\"type\":\"agent_end\",\"messages\":[]}");
    emitEvent("{\"type\":\"agent_settled\"}");
}

/** Run one scripted turn on the owned worker thread. */
void runTurn(const std::string &promptText)
{
    // `abort` stops the current turn, not the session: pi keeps serving the session, so the
    // latch is cleared before the next prompt instead of poisoning every later turn.
    g_aborted.store(false);
    g_streaming.store(true);
    const int sequence = ++g_turnIndex;
    const std::string label = markerLabel(promptText);
    appendLog(joinedLog("turn", "\"index\":" + std::to_string(sequence) + ",\"label\":\"" + label + "\""));
    if (promptText.find("abort-me") != std::string::npos) runAbortableTurn(sequence);
    else runStandardTurn(label, sequence);
    g_streaming.store(false);
}

/** Single consumer of queued prompts; exits only on stdin/EOF shutdown. */
void workerLoop()
{
    for (;;) {
        std::string text;
        {
            std::unique_lock<std::mutex> lock(g_jobMutex);
            g_jobCondition.wait(lock, [] { return g_jobPending || g_shutdown.load(); });
            if (g_shutdown.load() && !g_jobPending) return;
            text = g_jobText;
            g_jobText.clear();
            g_jobPending = false;
        }
        runTurn(text);
    }
}

void enqueueTurn(const std::string &promptText)
{
    {
        const std::lock_guard<std::mutex> lock(g_jobMutex);
        // The backend serializes prompts; overwriting is the honest fallback and shows up in
        // the log instead of silently running two turns at once.
        if (g_jobPending) appendLog(joinedLog("queue", "\"replaced\":true"));
        g_jobText = promptText;
        g_jobPending = true;
    }
    g_jobCondition.notify_all();
}

void handleFrame(const std::string &line)
{
    appendLog(joinedLog("command", "\"line\":" + line));
    const std::string type = fieldRaw(line, "type");
    const std::string idField = fieldRaw(line, "id", true);
    const std::string id = idField.empty() ? "null" : idField;
    if (type == "prompt") {
        std::string text = fieldRaw(line, "text");
        // pi's prompt frame carries the user text as `message` (string or object); older
        // shapes use `text`/`content`. Cover all three so the gate cannot silently send an
        // empty prompt and then assert against a fake turn that never echoed anything.
        if (text.empty()) text = fieldRaw(line, "content");
        if (text.empty()) text = fieldRaw(line, "message");
        appendLog(joinedLog("prompt", "\"text\":\"" + text + "\""));
        respond(id, type);
        enqueueTurn(text);
        return;
    }
    if (type == "abort") {
        const bool first = !g_aborted.exchange(true);
        g_streaming.store(false);
        // Wake a pending ask without pretending it was answered: the turn returns early
        // instead of emitting its continuation/message_end.
        g_answerCondition.notify_all();
        if (first) {
            appendLog(joinedLog("aborted", "\"source\":\"command\""));
            emitEvent("{\"type\":\"agent_end\",\"messages\":[]}");
            emitEvent("{\"type\":\"agent_settled\",\"aborted\":true}");
        }
        respond(id, type, "{\"aborted\":true}");
        return;
    }
    if (type == "extension_ui_response") {
        // pi correlates a UI answer by the ask id it published; unblock only the ask that is
        // currently outstanding so a late answer cannot satisfy a newer question.
        const std::string answerId = fieldRaw(line, "id");
        bool matched = false;
        {
            const std::lock_guard<std::mutex> lock(g_answerMutex);
            matched = !g_pendingAskId.empty() && answerId == g_pendingAskId;
            if (matched) g_pendingAskAnswered = true;
        }
        appendLog(joinedLog("ui-response", std::string("\"matched\":") + (matched ? "true" : "false") +
                                             ",\"line\":" + line));
        g_answerCondition.notify_all();
        respond(id, type);
        return;
    }
    if (type == "get_state") {
        std::string provider;
        std::string modelId;
        std::string thinkingLevel;
        {
            const std::lock_guard<std::mutex> lock(g_stateMutex);
            provider = g_modelProvider;
            modelId = g_modelId;
            thinkingLevel = g_thinkingLevel;
        }
        respond(id, type,
                std::string("{\"sessionId\":\"fake-pi-session\",\"sessionFile\":\"\","
                            "\"sessionName\":\"fake session\",\"model\":{\"provider\":\"") +
                    provider + "\",\"id\":\"" + modelId +
                    "\"},\"thinkingLevel\":\"" + thinkingLevel +
                    "\",\"isStreaming\":" + (g_streaming.load() ? "true}" : "false}"));
        return;
    }
    if (type == "set_model") {
        const std::string provider = fieldRaw(line, "provider");
        const std::string modelId = fieldRaw(line, "modelId");
        {
            const std::lock_guard<std::mutex> lock(g_stateMutex);
            if (!provider.empty()) g_modelProvider = provider;
            if (!modelId.empty()) g_modelId = modelId;
        }
        appendLog(joinedLog("model", "\"provider\":\"" + provider + "\",\"modelId\":\"" + modelId + "\""));
        respond(id, type, "{\"model\":{\"provider\":\"" + provider + "\",\"id\":\"" + modelId + "\"}}");
        return;
    }
    if (type == "get_messages") {
        respond(id, type, "{\"messages\":[]}");
        return;
    }
    if (type == "get_available_models") {
        respond(id, type,
                "{\"models\":[{\"id\":\"claude-sonnet-4\",\"provider\":\"anthropic\","
                "\"name\":\"Sonnet 4\"}]}");
        return;
    }
    if (type == "get_commands") {
        respond(id, type,
                "{\"commands\":[{\"name\":\"compact\",\"description\":\"Compact the session\"}]}");
        return;
    }
    if (type == "get_fork_messages") {
        respond(id, type, "{\"messages\":[]}");
        return;
    }
    if (type == "set_thinking_level") {
        const std::string level = fieldRaw(line, "level");
        if (!level.empty()) {
            const std::lock_guard<std::mutex> lock(g_stateMutex);
            g_thinkingLevel = level;
        }
        respond(id, type, "{\"thinkingLevel\":\"" + (level.empty() ? std::string("high") : level) + "\"}");
        return;
    }
    respond(id, type);
}

} // namespace

int main(int argc, char **argv)
{
    if (const char *log = std::getenv("FAKE_PI_LOG")) g_logPath = log;
    {
        std::string argvLog;
        for (int index = 1; index < argc; ++index) {
            if (!argvLog.empty()) argvLog += " ";
            argvLog += argv[index];
        }
        appendLog(joinedLog("exec", "\"argv\":\"" + argvLog + "\""));
    }
    // CLI probe modes: the environment check runs `pi --list-models` and the trust/version
    // probe runs `pi --version`, both expecting a one-shot process that exits. The runtime
    // launch always carries `--mode rpc`, which is the long-lived stdio protocol below.
    bool rpcMode = false;
    bool listModels = false;
    for (int index = 1; index < argc; ++index) {
        if (std::strcmp(argv[index], "--mode") == 0) rpcMode = true;
        if (std::strcmp(argv[index], "--list-models") == 0) listModels = true;
        if (std::strcmp(argv[index], "--version") == 0 && !rpcMode) {
            std::fputs("0.79.0\n", stdout);
            std::fflush(stdout);
            return 0;
        }
    }
    if (!rpcMode) {
        if (listModels) {
            // Human-readable table form (the backend's compatibility parser): provider,
            // model, context, max-out, thinking, images.
            std::fputs("provider   model              context  max-out  thinking  images\n"
                       "anthropic  claude-sonnet-4    200K     64K      yes       yes\n",
                       stdout);
        }
        std::fflush(stdout);
        return 0;
    }
    if (const char *log = std::getenv("FAKE_PI_LOG")) g_logPath = log;
    const char *session = std::getenv("PIDECK_SESSION_ID");
    appendLog(joinedLog("spawn", std::string("\"sessionId\":\"") + (session ? session : "") + "\""));
    // The turn worker is owned for the whole process: the stdin loop below must stay free to
    // read `extension_ui_response` and `abort` while a turn streams.
    std::thread worker(workerLoop);
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        handleFrame(line);
    }
    // pi exits when stdin closes; the backend closes it during shutdown. Signal the worker
    // (and any pending ask) before joining so nothing writes to stdout after main returns.
    g_shutdown.store(true);
    g_aborted.store(true);
    g_answerCondition.notify_all();
    {
        const std::lock_guard<std::mutex> lock(g_jobMutex);
    }
    g_jobCondition.notify_all();
    if (worker.joinable()) worker.join();
    std::fflush(stdout);
    return 0;
}
