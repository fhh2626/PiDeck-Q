// Test-only Windows launcher. Real HWND/WebView/clipboard tests run on a private
// window station, never the user's interactive desktop. No production startup flag.
#ifdef _WIN32
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {
constexpr DWORD kTargetTimeoutMs = 180'000;
constexpr DWORD kCleanupTimeoutMs = 5'000;
constexpr DWORD kQueueTimeoutMs = kTargetTimeoutMs + kCleanupTimeoutMs + 5'000;

/** Preserve Windows CRT argv quoting; never construct a shell command. */
std::wstring quote(const std::wstring &argument)
{
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t value : argument) {
        if (value == L'\\') { ++slashes; continue; }
        result.append(slashes * (value == L'\"' ? 2 : 1), L'\\');
        slashes = 0;
        if (value == L'\"') result += L'\\';
        result += value;
    }
    result.append(slashes * 2, L'\\');
    return result + L'\"';
}

std::wstring objectName(HANDLE handle)
{
    wchar_t buffer[512]{};
    DWORD needed = 0;
    if (!GetUserObjectInformationW(handle, UOI_NAME, buffer, sizeof(buffer), &needed)) return {};
    return buffer;
}

int fail(const char *operation)
{
    std::fprintf(stderr, "isolated-desktop: %s failed (%lu)\n", operation, GetLastError());
    return 125;
}

/** Child probe proves that real windows and clipboard work outside WinSta0. */
int probe()
{
    USEROBJECTFLAGS flags{};
    DWORD needed = 0;
    if (!GetUserObjectInformationW(GetProcessWindowStation(), UOI_FLAGS, &flags, sizeof(flags), &needed)
        || (flags.dwFlags & WSF_VISIBLE)
        || objectName(GetThreadDesktop(GetCurrentThreadId())).find(L"PiDeck-") != 0)
        return fail("isolation verification");
    HWND window = CreateWindowExW(0, L"STATIC", L"Isolated test probe", WS_OVERLAPPEDWINDOW,
                                  0, 0, 320, 240, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!window) return fail("probe HWND");
    ShowWindow(window, SW_SHOW);
    RECT bounds{};
    if (!GetWindowRect(window, &bounds) || bounds.right <= bounds.left) return fail("probe geometry");
    if (!OpenClipboard(window)) return fail("private clipboard");
    EmptyClipboard();
    const wchar_t text[] = L"PiDeck private clipboard probe";
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, sizeof(text));
    if (!memory) return fail("clipboard allocation");
    void *data = GlobalLock(memory);
    if (!data) return fail("clipboard lock");
    CopyMemory(data, text, sizeof(text));
    GlobalUnlock(memory);
    if (!SetClipboardData(CF_UNICODETEXT, memory)) return fail("clipboard write");
    CloseClipboard();
    DestroyWindow(window);
    std::puts("private HWND and clipboard verified");
    return 0;
}

/** Handles remain alive until all job descendants are terminated, including WebView2. */
struct Isolation {
    HWINSTA station = nullptr;
    HDESK desktop = nullptr;
    HANDLE job = nullptr;
    HANDLE mutex = nullptr;
    bool ownsMutex = false;
    ~Isolation()
    {
        if (job) { TerminateJobObject(job, 0); CloseHandle(job); }
        if (desktop) CloseDesktop(desktop);
        if (station) CloseWindowStation(station);
        if (ownsMutex) ReleaseMutex(mutex);
        if (mutex) CloseHandle(mutex);
    }
};

} // namespace

int wmain(int argc, wchar_t **argv)
{
    // Children inherit this mode: loader/crash failures must report an exit code,
    // not block unattended runs on a Windows system-error dialog.
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    if (argc == 2 && std::wstring(argv[1]) == L"--probe") return probe();
    if (argc == 2 && std::wstring(argv[1]) == L"--policy") {
        std::printf("{\"targetMs\":%lu,\"cleanupMs\":%lu,\"queueMs\":%lu}\n", kTargetTimeoutMs, kCleanupTimeoutMs, kQueueTimeoutMs);
        return 0;
    }
    const bool selfTest = argc == 2 && std::wstring(argv[1]) == L"--self-test";
    if (!selfTest && argc < 2) {
        std::fputs("usage: PiDeck-IsolatedDesktop <executable> [arguments...]\n", stderr);
        return 125;
    }
    const HWINSTA originalStation = GetProcessWindowStation();
    const std::wstring originalName = objectName(originalStation);
    // Let Windows allocate the caller's noninteractive station. Unprivileged
    // accounts cannot create arbitrary named stations on all Windows editions.
    std::wstring stationName;
    Isolation isolation;
    isolation.station = CreateWindowStationW(nullptr, 0, WINSTA_ALL_ACCESS, nullptr);
    if (isolation.station) stationName = objectName(isolation.station);
    if (!isolation.station) {
        const DWORD error = GetLastError();
        JOBOBJECT_BASIC_UI_RESTRICTIONS restrictions{};
        QueryInformationJobObject(nullptr, JobObjectBasicUIRestrictions, &restrictions, sizeof(restrictions), nullptr);
        std::fprintf(stderr, "isolation diagnostic: job UI restrictions=%lu\n", restrictions.UIRestrictionsClass);
        SetLastError(error);
        return fail("CreateWindowStation");
    }
    USEROBJECTFLAGS stationFlags{};
    DWORD needed = 0;
    if (!GetUserObjectInformationW(isolation.station, UOI_FLAGS, &stationFlags, sizeof(stationFlags), &needed)
        || (stationFlags.dwFlags & WSF_VISIBLE)) return fail("noninteractive station verification");
    // Windows may reuse its per-logon noninteractive station. Serialize test jobs
    // there so concurrent native suites cannot mutate each other's private clipboard.
    const std::wstring mutexName = L"Local\\PiDeck-Isolated-" + stationName;
    isolation.mutex = CreateMutexW(nullptr, FALSE, mutexName.c_str());
    if (!isolation.mutex) return fail("isolation mutex");
    const DWORD lock = WaitForSingleObject(isolation.mutex, kQueueTimeoutMs);
    if (lock != WAIT_OBJECT_0 && lock != WAIT_ABANDONED) return fail("isolation mutex deadline");
    isolation.ownsMutex = true;
    const std::wstring desktopLeaf = L"PiDeck-" + std::to_wstring(GetCurrentProcessId())
        + L"-" + std::to_wstring(GetTickCount64());
    if (!SetProcessWindowStation(isolation.station)) return fail("SetProcessWindowStation");
    isolation.desktop = CreateDesktopW(desktopLeaf.c_str(), nullptr, nullptr, 0, GENERIC_ALL, nullptr);
    const DWORD creationError = GetLastError();
    if (!SetProcessWindowStation(originalStation)) return fail("restore window station");
    if (!isolation.desktop) { SetLastError(creationError); return fail("CreateDesktop"); }
    if (objectName(GetProcessWindowStation()) != originalName) return fail("parent station changed");

    isolation.job = CreateJobObjectW(nullptr, nullptr);
    if (!isolation.job) return fail("CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(isolation.job, JobObjectExtendedLimitInformation, &limit, sizeof(limit)))
        return fail("job limit");

    wchar_t ownPath[32768]{};
    if (selfTest && !GetModuleFileNameW(nullptr, ownPath, DWORD(std::size(ownPath)))) return fail("launcher path");
    const std::wstring program = selfTest ? ownPath : argv[1];
    std::wstring command = quote(program);
    if (selfTest) command += L" --probe";
    else for (int index = 2; index < argc; ++index) command += L" " + quote(argv[index]);
    std::vector<wchar_t> writable(command.begin(), command.end());
    writable.push_back(L'\0');
    std::wstring desktopName = stationName + L"\\" + desktopLeaf;
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.lpDesktop = desktopName.data();
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    for (HANDLE handle : {startup.hStdInput, startup.hStdOutput, startup.hStdError}) {
        if (handle && handle != INVALID_HANDLE_VALUE) SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
    PROCESS_INFORMATION child{};
    // Suspend until job ownership is installed so no renderer/sidecar can escape cleanup.
    if (!CreateProcessW(program.c_str(), writable.data(), nullptr, nullptr, TRUE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child))
        return fail("CreateProcess");
    if (!AssignProcessToJobObject(isolation.job, child.hProcess)) {
        const DWORD error = GetLastError();
        TerminateProcess(child.hProcess, 125);
        CloseHandle(child.hThread); CloseHandle(child.hProcess);
        SetLastError(error);
        return fail("AssignProcessToJobObject");
    }
    std::fprintf(stderr, "isolated-desktop: noninteractive station established\n");
    ResumeThread(child.hThread);
    CloseHandle(child.hThread);
    const DWORD waited = WaitForSingleObject(child.hProcess, selfTest ? 10'000 : kTargetTimeoutMs);
    DWORD exitCode = 125;
    if (waited == WAIT_OBJECT_0) GetExitCodeProcess(child.hProcess, &exitCode);
    else std::fputs("isolated-desktop: target exceeded its unattended execution deadline\n", stderr);
    CloseHandle(child.hProcess);
    // Stop orphaned descendants before the station/desktop are released. This has no
    // effect on the target's exit status and never touches another application tree.
    TerminateJobObject(isolation.job, 0);
    const ULONGLONG cleanupDeadline = GetTickCount64() + kCleanupTimeoutMs;
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    while (QueryInformationJobObject(isolation.job, JobObjectBasicAccountingInformation,
                                     &accounting, sizeof(accounting), nullptr)
           && accounting.ActiveProcesses != 0 && GetTickCount64() < cleanupDeadline) {
        // Termination is asynchronous. Wait for actual process exit so Chromium
        // profile handles are released before Node removes the fixture directory.
        Sleep(10);
    }
    if (accounting.ActiveProcesses != 0) {
        std::fputs("isolated-desktop: descendants did not finish cleanup\n", stderr);
        return 125;
    }
    return int(exitCode);
}
#else
int main() { return 125; }
#endif
