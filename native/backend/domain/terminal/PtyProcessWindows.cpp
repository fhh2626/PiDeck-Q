#include "PtyProcess.h"

#ifdef Q_OS_WIN

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <atomic>
#include <mutex>
#include <thread>
#include <vector>

namespace terminal {
namespace {

QString win32Message(const QString &prefix, DWORD code)
{
    wchar_t *text = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT), reinterpret_cast<wchar_t *>(&text), 0, nullptr);
    QString detail;
    if (length > 0 && text) {
        detail = QString::fromWCharArray(text, int(length)).trimmed();
        LocalFree(text);
    }
    if (detail.isEmpty()) return QStringLiteral("%1 (error %2)").arg(prefix).arg(code);
    return QStringLiteral("%1: %2").arg(prefix, detail);
}

/**
 * Quote one argument following the CommandLineToArgvW rules used by the CRT.
 * Naive `"%1"` quoting corrupts arguments that contain quotes or trailing
 * backslashes, and cmd-style `""` escaping is not understood by argv parsing.
 */
void appendQuotedArgument(QString *command, const QString &argument)
{
    bool needsQuoting = argument.isEmpty();
    for (const QChar character : argument) {
        if (character == QLatin1Char(' ') || character == QLatin1Char('\t') || character == QLatin1Char('\n')
            || character == QLatin1Char('\v') || character == QLatin1Char('"')) {
            needsQuoting = true;
            break;
        }
    }
    if (!needsQuoting) {
        command->append(argument);
        return;
    }
    command->append(QLatin1Char('"'));
    int backslashes = 0;
    for (const QChar character : argument) {
        if (character == QLatin1Char('\\')) {
            ++backslashes;
            continue;
        }
        if (character == QLatin1Char('"')) {
            command->append(QString(backslashes * 2 + 1, QLatin1Char('\\')));
            command->append(QLatin1Char('"'));
            backslashes = 0;
            continue;
        }
        if (backslashes > 0) command->append(QString(backslashes, QLatin1Char('\\')));
        backslashes = 0;
        command->append(character);
    }
    if (backslashes > 0) command->append(QString(backslashes * 2, QLatin1Char('\\')));
    command->append(QLatin1Char('"'));
}

/** UTF-16 environment block from the sanitized child environment. */
std::vector<wchar_t> environmentBlock(const QProcessEnvironment &environment)
{
    std::vector<wchar_t> block;
    const QStringList keys = environment.keys();
    for (const QString &key : keys) {
        const QString entry = key + QLatin1Char('=') + environment.value(key) + QChar(0);
        block.insert(block.end(), entry.utf16(), entry.utf16() + entry.size());
    }
    block.push_back(L'\0');
    return block;
}

} // namespace

struct PtyProcess::State {
    HPCON console = nullptr;
    /** PTY-side pipe ends owned by the pseudoconsole; closed with it. */
    HANDLE consoleInput = nullptr;
    HANDLE consoleOutput = nullptr;
    HANDLE inputWrite = nullptr;
    HANDLE outputRead = nullptr;
    HANDLE process = nullptr;
    std::thread reader;
    std::thread waiter;
    std::atomic<bool> exited{false};
    std::atomic<bool> killRequested{false};
    std::mutex consoleMutex;
    bool consoleClosed = false;
    Callbacks callbacks;

    /**
     * Close the pseudoconsole exactly once.
     *
     * Closing is what unblocks the reader thread: ConPTY closes the write end of the
     * output pipe, so the pending ReadFile returns instead of waiting for a process
     * that is already gone.
     */
    void closeConsole()
    {
        std::lock_guard<std::mutex> lock(consoleMutex);
        if (consoleClosed) return;
        consoleClosed = true;
        if (console) {
            ClosePseudoConsole(console);
            console = nullptr;
        }
        if (consoleInput) {
            CloseHandle(consoleInput);
            consoleInput = nullptr;
        }
        if (consoleOutput) {
            CloseHandle(consoleOutput);
            consoleOutput = nullptr;
        }
    }
};

PtyProcess::PtyProcess(std::shared_ptr<State> state)
    : m_state(std::move(state))
{
}

std::unique_ptr<PtyProcess> PtyProcess::spawn(const QString &command, const QStringList &args,
                                              const QString &cwd, const PtySize &size,
                                              const QProcessEnvironment &environment,
                                              Callbacks callbacks, QString *error)
{
    if (command.isEmpty()) {
        if (error) *error = QStringLiteral("terminal program is required");
        return nullptr;
    }
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE inputRead = nullptr;
    HANDLE inputWrite = nullptr;
    HANDLE outputRead = nullptr;
    HANDLE outputWrite = nullptr;
    if (!CreatePipe(&inputRead, &inputWrite, &attributes, 0)) {
        if (error) *error = win32Message(QStringLiteral("terminal pipes failed"), GetLastError());
        return nullptr;
    }
    if (!CreatePipe(&outputRead, &outputWrite, &attributes, 0)) {
        const DWORD code = GetLastError();
        CloseHandle(inputRead);
        CloseHandle(inputWrite);
        if (error) *error = win32Message(QStringLiteral("terminal pipes failed"), code);
        return nullptr;
    }
    // The host-side ends stay private to this process; only the two ends handed to
    // CreatePseudoConsole may be inherited by the console host.
    SetHandleInformation(inputWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(outputRead, HANDLE_FLAG_INHERIT, 0);

    const COORD consoleSize{static_cast<SHORT>(qMax(1, size.cols)), static_cast<SHORT>(qMax(1, size.rows))};
    HPCON console = nullptr;
    const HRESULT created = CreatePseudoConsole(consoleSize, inputRead, outputWrite, 0, &console);
    if (FAILED(created)) {
        CloseHandle(inputRead);
        CloseHandle(inputWrite);
        CloseHandle(outputRead);
        CloseHandle(outputWrite);
        if (error) *error = QStringLiteral("ConPTY creation failed (0x%1)").arg(quint32(created), 8, 16, QLatin1Char('0'));
        return nullptr;
    }
    // The PTY-side ends stay open for the whole console lifetime. ConPTY does not
    // duplicate them: closing the input end makes the child read EOF and exit at once
    // (cmd.exe exits 0 before it ever prints a prompt). They are closed together with
    // the console in State::closeConsole().

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(STARTUPINFOEXW);
    // The child must not inherit the backend std handles: cmd.exe would write its banner
    // to the backend pipe and read EOF from it instead of using the pseudoconsole.
    startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nullptr;
    startup.StartupInfo.hStdOutput = nullptr;
    startup.StartupInfo.hStdError = nullptr;
    SIZE_T attributeSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
    startup.lpAttributeList = static_cast<PPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, attributeSize));
    bool attributesReady = startup.lpAttributeList != nullptr
        && InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeSize)
        && UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console,
                                     sizeof(console), nullptr, nullptr);
    if (!attributesReady) {
        const DWORD code = GetLastError();
        if (startup.lpAttributeList) {
            DeleteProcThreadAttributeList(startup.lpAttributeList);
            HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
        }
        ClosePseudoConsole(console);
        CloseHandle(inputRead);
        CloseHandle(outputWrite);
        CloseHandle(inputWrite);
        CloseHandle(outputRead);
        if (error) *error = win32Message(QStringLiteral("terminal attributes failed"), code);
        return nullptr;
    }

    QString commandLine;
    appendQuotedArgument(&commandLine, command);
    for (const QString &argument : args) {
        commandLine.append(QLatin1Char(' '));
        appendQuotedArgument(&commandLine, argument);
    }
    std::vector<wchar_t> commandBuffer(static_cast<size_t>(commandLine.size()) + 32, L'\0');
    commandLine.toWCharArray(commandBuffer.data());
    std::vector<wchar_t> environmentData = environmentBlock(environment);
    // `QString::toStdWString()` must not be used here: std::wstring has no stable ABI on
    // MSVC and the debug build's _ITERATOR_DEBUG_LEVEL differs from the release-built Qt
    // DLL, so the returned object faults when it is destroyed. A plain wide buffer keeps
    // the boundary Qt-free.
    std::vector<wchar_t> workingDirectory;
    if (!cwd.isEmpty()) {
        workingDirectory.resize(static_cast<size_t>(cwd.size()) + 1, L'\0');
        cwd.toWCharArray(workingDirectory.data());
    }

    PROCESS_INFORMATION process{};
    const BOOL started = CreateProcessW(
        nullptr, commandBuffer.data(), nullptr, nullptr, FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, environmentData.data(),
        workingDirectory.empty() ? nullptr : workingDirectory.data(), &startup.StartupInfo, &process);
    const DWORD startError = started ? 0 : GetLastError();
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
    if (!started) {
        ClosePseudoConsole(console);
        CloseHandle(inputRead);
        CloseHandle(outputWrite);
        CloseHandle(inputWrite);
        CloseHandle(outputRead);
        if (error) *error = win32Message(QStringLiteral("terminal command failed to start"), startError);
        return nullptr;
    }
    CloseHandle(process.hThread);

    auto state = std::make_shared<State>();
    state->console = console;
    state->consoleInput = inputRead;
    state->consoleOutput = outputWrite;
    state->inputWrite = inputWrite;
    state->outputRead = outputRead;
    state->process = process.hProcess;
    state->callbacks = std::move(callbacks);

    // The reader blocks on the PTY. ConPTY renders asynchronously, so a quiet gap is
    // never evidence that the child produced no output.
    state->reader = std::thread([state] {
        std::vector<char> buffer(64 * 1024);
        for (;;) {
            DWORD read = 0;
            const BOOL ok = ReadFile(state->outputRead, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr);
            if (!ok || read == 0) break;
            if (state->callbacks.onData) state->callbacks.onData(QByteArray(buffer.data(), static_cast<int>(read)));
        }
    });

    // The waiter owns the exit sequence: observe the exit, close the console so the
    // reader can finish, then report. Joining the reader first guarantees every data
    // callback happened before the exit callback.
    state->waiter = std::thread([state] {
        WaitForSingleObject(state->process, INFINITE);
        DWORD code = 0;
        GetExitCodeProcess(state->process, &code);
        state->exited = true;
        state->closeConsole();
        if (state->reader.joinable()) state->reader.join();
        if (state->callbacks.onExit) state->callbacks.onExit(static_cast<int>(code));
    });

    return std::unique_ptr<PtyProcess>(new PtyProcess(std::move(state)));
}

PtyProcess::~PtyProcess()
{
    if (!m_state) return;
    kill();
    if (m_state->waiter.joinable()) m_state->waiter.join();
    // The waiter joins the reader; this only covers a spawn that produced no waiter.
    if (m_state->reader.joinable()) m_state->reader.join();
    if (m_state->inputWrite) CloseHandle(m_state->inputWrite);
    if (m_state->outputRead) CloseHandle(m_state->outputRead);
    if (m_state->process) CloseHandle(m_state->process);
    m_state->inputWrite = nullptr;
    m_state->outputRead = nullptr;
    m_state->process = nullptr;
}

bool PtyProcess::write(const QByteArray &data, QString *error)
{
    if (!m_state || m_state->exited) {
        if (error) *error = QStringLiteral("terminal process has exited");
        return false;
    }
    if (data.isEmpty()) return true;
    DWORD written = 0;
    if (!WriteFile(m_state->inputWrite, data.constData(), static_cast<DWORD>(data.size()), &written, nullptr)) {
        if (error) *error = win32Message(QStringLiteral("terminal input was not written"), GetLastError());
        return false;
    }
    return true;
}

bool PtyProcess::resize(int cols, int rows)
{
    if (!m_state || m_state->exited) return false;
    std::lock_guard<std::mutex> lock(m_state->consoleMutex);
    if (m_state->consoleClosed || !m_state->console) return false;
    const COORD size{static_cast<SHORT>(qMax(1, cols)), static_cast<SHORT>(qMax(1, rows))};
    return SUCCEEDED(ResizePseudoConsole(m_state->console, size));
}

void PtyProcess::kill()
{
    if (!m_state) return;
    if (m_state->killRequested.exchange(true)) return;
    if (m_state->process) TerminateProcess(m_state->process, 1);
}

bool PtyProcess::running() const
{
    return m_state && !m_state->exited;
}

} // namespace terminal

#endif // Q_OS_WIN
