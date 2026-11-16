// Test-only `wsl.exe` stand-in: forwards its argv, unchanged, to the node fixture.
//
// Why this exists: `PIDECK_WSL_EXE` has to be an executable. A `.cmd` shim is wrapped by
// `cmd.exe /s /c`, and the batch body reader passes an `sh -c` script that itself contains
// double quotes and `%`-sequences; `cmd.exe` re-parses that command line, so the argv the
// fixture would see is not the argv the backend produced. That would make a "paths with
// spaces/quotes/shell characters arrive as positional arguments" assertion meaningless.
// The Windows CRT's `spawnv` family is not an option either: it wraps an argument that
// contains spaces in quotes without escaping the quotes inside it, which mangles the same
// script argument. So the command line is built here with the documented quoting rules.
//
// The child shares this process's stdio handles (no copying), so the fixture's NUL-framed
// output reaches the backend byte for byte and a killed batch still exposes the bytes the
// fixture already printed. Deliberately Qt-free: the backend spawns this with the desktop
// PATH, which does not contain the build's Qt runtime.
//
// Env:
//   FAKE_WSL_SCRIPT  node fixture to run (required)
//   FAKE_WSL_NODE    node executable (default: resolve `node` through PATH)
#include <cstdio>
#include <cstdlib>

#ifdef _WIN32
#include <windows.h>

#include <string>
#include <vector>

namespace {

std::wstring widen(const char *value)
{
    if (!value) return std::wstring();
    const int size = MultiByteToWideChar(CP_UTF8, 0, value, -1, nullptr, 0);
    if (size <= 0) return std::wstring();
    std::wstring wide(size_t(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value, -1, wide.data(), size);
    wide.resize(size_t(size - 1));
    return wide;
}

/**
 * Quote one argv element for CreateProcessW (the same rules the MSVC CRT parses back):
 * wrap in quotes when it contains whitespace or a quote, double the backslashes that
 * precede a quote, and escape embedded quotes.
 */
std::wstring quoteArgument(const std::wstring &argument)
{
    if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
        return argument;
    }
    std::wstring quoted(1, L'"');
    for (auto it = argument.begin();; ++it) {
        size_t backslashes = 0;
        while (it != argument.end() && *it == L'\\') {
            ++it;
            ++backslashes;
        }
        if (it == argument.end()) {
            quoted.append(backslashes * 2, L'\\');
            break;
        }
        if (*it == L'"') {
            quoted.append(backslashes * 2 + 1, L'\\');
            quoted.push_back(L'"');
        } else {
            quoted.append(backslashes, L'\\');
            quoted.push_back(*it);
        }
    }
    quoted.push_back(L'"');
    return quoted;
}

} // namespace

int main(int argc, char **argv)
{
    const char *scriptValue = std::getenv("FAKE_WSL_SCRIPT");
    if (!scriptValue || !*scriptValue) {
        std::fprintf(stderr, "fake-wsl: FAKE_WSL_SCRIPT is not set\n");
        return 127;
    }
    const char *configured = std::getenv("FAKE_WSL_NODE");
    const std::wstring node = (configured && *configured) ? widen(configured) : L"node";
    std::wstring commandLine = quoteArgument(node);
    commandLine += L' ';
    commandLine += quoteArgument(widen(scriptValue));
    for (int index = 1; index < argc; ++index) {
        commandLine += L' ';
        commandLine += quoteArgument(widen(argv[index]));
    }
    std::vector<wchar_t> mutableLine(commandLine.begin(), commandLine.end());
    mutableLine.push_back(L'\0');

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    // The backend hands over a pipe; inherit it instead of copying bytes here, so a kill
    // cannot lose the prefix the fixture already wrote.
    for (HANDLE handle : {startup.hStdInput, startup.hStdOutput, startup.hStdError}) {
        if (handle && handle != INVALID_HANDLE_VALUE) {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        }
    }
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(nullptr, mutableLine.data(), nullptr, nullptr, TRUE, 0, nullptr, nullptr,
                        &startup, &child)) {
        std::fprintf(stderr, "fake-wsl: could not start node (%lu)\n", GetLastError());
        return 127;
    }
    CloseHandle(child.hThread);
    WaitForSingleObject(child.hProcess, INFINITE);
    DWORD exitCode = 127;
    GetExitCodeProcess(child.hProcess, &exitCode);
    CloseHandle(child.hProcess);
    return int(exitCode);
}
#else
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <unistd.h>

int main(int argc, char **argv)
{
    const char *script = std::getenv("FAKE_WSL_SCRIPT");
    if (!script || !*script) {
        std::fprintf(stderr, "fake-wsl: FAKE_WSL_SCRIPT is not set\n");
        return 127;
    }
    const char *configured = std::getenv("FAKE_WSL_NODE");
    const char *node = (configured && *configured) ? configured : "node";
    std::vector<char *> forwarded;
    forwarded.reserve(size_t(argc) + 2);
    forwarded.push_back(const_cast<char *>(node));
    forwarded.push_back(const_cast<char *>(script));
    for (int index = 1; index < argc; ++index) forwarded.push_back(argv[index]);
    forwarded.push_back(nullptr);
    execvp(node, forwarded.data());
    std::fprintf(stderr, "fake-wsl: could not start node\n");
    return 127;
}
#endif
