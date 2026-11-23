#include "ThreadStackReport.h"

#include <QByteArray>
#include <QMutex>
#include <QMutexLocker>

#include <cstdio>
#include <cstdarg>
#include <thread>

// Debug-only: a shipped release backend must not depend on DbgHelp. `NDEBUG` is the
// MSVC release marker, so every debug/test build keeps the helper available.
#if defined(Q_OS_WIN) && !defined(NDEBUG)
#define PIDECK_STACK_REPORT 1
#endif

#ifdef PIDECK_STACK_REPORT
#include <windows.h>
#include <dbghelp.h>
#include <tlhelp32.h>

#include <vector>

#pragma comment(lib, "dbghelp.lib")
#endif

namespace stackreport {
namespace {

struct ReportConfig {
    bool active = false;
    int delayMs = 0;
    QByteArray path;
};

ReportConfig readConfig()
{
    ReportConfig config;
#ifdef PIDECK_STACK_REPORT
    bool ok = false;
    const int delay = qEnvironmentVariableIntValue("PIDECK_STACK_DUMP_MS", &ok);
    if (!ok || delay <= 0) return config;
    const QByteArray path = qgetenv("PIDECK_STACK_DUMP_FILE");
    if (path.isEmpty()) return config;
    config.active = true;
    config.delayMs = delay;
    config.path = path;
#endif
    return config;
}

const ReportConfig &config()
{
    static const ReportConfig value = readConfig();
    return value;
}

#ifdef PIDECK_STACK_REPORT

QMutex &writeMutex()
{
    static QMutex mutex;
    return mutex;
}

void writeLine(FILE *file, const char *format, ...)
{
    va_list args;
    va_start(args, format);
    std::vfprintf(file, format, args);
    va_end(args);
    std::fflush(file);
}

/** One decoded frame: `module!symbol+offset [file:line]`. */
void appendFrame(FILE *file, HANDLE process, DWORD64 address)
{
    QByteArray moduleName("?");
    const DWORD64 base = SymGetModuleBase64(process, address);
    if (base != 0) {
        char modulePath[MAX_PATH]{};
        if (GetModuleFileNameA(reinterpret_cast<HMODULE>(base), modulePath, MAX_PATH) > 0) {
            const char *leaf = std::strrchr(modulePath, '\\');
            moduleName = leaf ? leaf + 1 : modulePath;
        }
    }
    const DWORD64 moduleOffset = base != 0 ? address - base : address;

    union {
        SYMBOL_INFO info;
        char storage[sizeof(SYMBOL_INFO) + 512];
    } symbol{};
    symbol.info.SizeOfStruct = sizeof(SYMBOL_INFO);
    symbol.info.MaxNameLen = 511;
    DWORD64 displacement = 0;
    if (SymFromAddr(process, address, &displacement, &symbol.info)) {
        IMAGEHLP_LINE64 line{};
        line.SizeOfStruct = sizeof(IMAGEHLP_LINE64);
        DWORD lineOffset = 0;
        if (SymGetLineFromAddr64(process, address, &lineOffset, &line)) {
            writeLine(file, "    %s!%s+0x%llx [%s:%lu]\n", moduleName.constData(),
                      symbol.info.Name, static_cast<unsigned long long>(displacement),
                      line.FileName, line.LineNumber);
            return;
        }
        writeLine(file, "    %s!%s+0x%llx\n", moduleName.constData(), symbol.info.Name,
                  static_cast<unsigned long long>(displacement));
        return;
    }
    writeLine(file, "    %s+0x%llx\n", moduleName.constData(),
              static_cast<unsigned long long>(moduleOffset));
}

/** Walk one suspended thread from its captured context. */
void appendThread(FILE *file, HANDLE process, HANDLE thread, DWORD threadId)
{
    CONTEXT context{};
    context.ContextFlags = CONTEXT_FULL;
    if (!GetThreadContext(thread, &context)) {
        writeLine(file, "  thread %lu: GetThreadContext failed (%lu)\n", threadId, GetLastError());
        return;
    }
    writeLine(file, "  thread %lu:\n", threadId);

    STACKFRAME64 frame{};
    frame.AddrPC.Offset = context.Rip;
    frame.AddrPC.Mode = AddrModeFlat;
    frame.AddrStack.Offset = context.Rsp;
    frame.AddrStack.Mode = AddrModeFlat;
    frame.AddrFrame.Offset = context.Rbp;
    frame.AddrFrame.Mode = AddrModeFlat;

    // Bounded: a corrupted stack walk must never spin during diagnosis.
    for (int depth = 0; depth < 32; ++depth) {
        if (!StackWalk64(IMAGE_FILE_MACHINE_AMD64, process, thread, &frame, &context, nullptr,
                         SymFunctionTableAccess64, SymGetModuleBase64, nullptr)) {
            break;
        }
        if (frame.AddrPC.Offset == 0) break;
        appendFrame(file, process, frame.AddrPC.Offset);
    }
}

/** Dump every thread of this process (the caller included, without suspending itself). */
void writeReport(const QByteArray &path)
{
    const HANDLE process = GetCurrentProcess();
    SymSetOptions(SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS | SYMOPT_LOAD_LINES);
    if (!SymInitialize(process, nullptr, TRUE)) {
        QMutexLocker lock(&writeMutex());
        if (FILE *file = std::fopen(path.constData(), "ab")) {
            writeLine(file, "stackreport: SymInitialize failed (%lu)\n", GetLastError());
            std::fclose(file);
        }
        return;
    }

    std::vector<DWORD> threadIds;
    const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot != INVALID_HANDLE_VALUE) {
        THREADENTRY32 entry{};
        entry.dwSize = sizeof(THREADENTRY32);
        if (Thread32First(snapshot, &entry)) {
            do {
                if (entry.th32OwnerProcessID == GetCurrentProcessId()) threadIds.push_back(entry.th32ThreadID);
            } while (Thread32Next(snapshot, &entry));
        }
        CloseHandle(snapshot);
    }

    FILE *file = nullptr;
    {
        QMutexLocker lock(&writeMutex());
        file = std::fopen(path.constData(), "ab");
        if (!file) {
            SymCleanup(process);
            return;
        }
        writeLine(file, "==== stack report: %zu threads ====\n", threadIds.size());
    }

    const DWORD self = GetCurrentThreadId();
    for (const DWORD threadId : threadIds) {
        // Suspend/resume is skipped for the reporting thread: it is the one that cannot
        // be walked from a context it does not have.
        if (threadId == self) {
            QMutexLocker lock(&writeMutex());
            writeLine(file, "  thread %lu: reporter (skipped)\n", threadId);
            continue;
        }
        const HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION,
                                         FALSE, threadId);
        if (!thread) continue;
        const DWORD previous = SuspendThread(thread);
        if (previous != DWORD(-1)) {
            QMutexLocker lock(&writeMutex());
            appendThread(file, process, thread, threadId);
            ResumeThread(thread);
        }
        CloseHandle(thread);
    }

    {
        QMutexLocker lock(&writeMutex());
        writeLine(file, "==== end stack report ====\n");
        std::fclose(file);
    }
    SymCleanup(process);
}

#endif // PIDECK_STACK_REPORT

} // namespace

bool enabled()
{
    return config().active;
}

void arm()
{
    if (!config().active) return;
#ifdef PIDECK_STACK_REPORT
    const QByteArray path = config().path;
    const int delayMs = config().delayMs;
    // Detached on purpose: the report must be able to run while the main thread is stuck,
    // and it must never gate process exit.
    std::thread([path, delayMs]() {
        std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
        writeReport(path);
    }).detach();
#endif
}

} // namespace stackreport
