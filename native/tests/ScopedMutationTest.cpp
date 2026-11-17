#include "../common/ScopedMutation.h"
#include "../src/NativeFileShell.h"
#include "../backend/domain/fs/EntryLink.h"
#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QFile>
#include <cstring>
#include <iostream>
#include <memory>
#ifdef Q_OS_WIN
#include <windows.h>
#include <winioctl.h>
#include <vector>
#else
#include <unistd.h>
#endif

#ifdef Q_OS_WIN
/** Try an in-place junction conversion, not just a directory rename. */
int reparse(const QString &target, const QString &destination)
{
    const QString native = QDir::toNativeSeparators(target);
    std::vector<wchar_t> name(size_t(native.size()) + 1, L'\0');
    native.toWCharArray(name.data());
    HANDLE handle = CreateFileW(name.data(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) { std::cout << "blocked" << std::endl; return 0; }
    const QString substitute = QStringLiteral("\\??\\") + QDir::toNativeSeparators(destination);
    const WORD length = WORD(substitute.size() * sizeof(wchar_t));
    const WORD dataLength = WORD(8 + length + 4);
    std::vector<unsigned char> data(size_t(dataLength) + 8, 0);
    const DWORD tag = IO_REPARSE_TAG_MOUNT_POINT;
    const WORD offset = WORD(length + 2), zero = 0;
    std::memcpy(data.data(), &tag, 4);
    std::memcpy(data.data() + 4, &dataLength, 2);
    std::memcpy(data.data() + 8, &zero, 2);
    std::memcpy(data.data() + 10, &length, 2);
    std::memcpy(data.data() + 12, &offset, 2);
    substitute.toWCharArray(reinterpret_cast<wchar_t *>(data.data() + 16));
    DWORD returned = 0;
    const bool ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, data.data(), DWORD(data.size()), nullptr, 0, &returned, nullptr);
    CloseHandle(handle);
    std::cout << (ok ? "changed" : "blocked") << std::endl;
    return 0;
}
#endif

/** A stdin barrier makes filesystem races deterministic without timers or a GUI. */
int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    const auto args = app.arguments();
    if (args.size() != 4) return 2;
    const QString mode = args.at(1), rootPath = args.at(2), target = args.at(3);
#ifdef Q_OS_WIN
    if (mode == "reparse") return reparse(target, rootPath);
#endif
    try {
        const auto root = scopedmutation::captureRoot(rootPath);
        const QString operationTarget = scopedmutation::mapTarget(root, rootPath, target);
        std::unique_ptr<scopedmutation::Parent> held;
        if (mode == "hold" || mode.startsWith("held-")) held = std::make_unique<scopedmutation::Parent>(root, operationTarget);
        std::cout << "ready" << std::endl;
        std::string resume;
        std::getline(std::cin, resume);
        if (mode == "trash") {
            const auto result = trashNativeItem({{"path", operationTarget}, {"typedFailure", true}, {"scope", root.toJson()}});
            std::cout << (result.isNull() ? "trashed" : "refused") << std::endl;
        } else if (mode == "hold") {
            held.reset();
            std::cout << "released" << std::endl;
            std::getline(std::cin, resume); // Verify handle release while this process remains alive.
        } else if (mode.startsWith("held-")) {
#ifdef Q_OS_WIN
            return 2;
#else
            if (mode == "held-trash") {
                std::cout << (scopedmutation::moveToTrash(*held) ? "trashed" : "refused") << std::endl;
            } else {
                scopedmutation::removeTree(*held);
                std::cout << "removed" << std::endl;
            }
#endif
        } else if (mode == "remove") {
#ifdef Q_OS_WIN
            const scopedmutation::Parent guard(root, operationTarget);
            fsops::removeEntryTree(operationTarget);
#else
            scopedmutation::removeTree(root, operationTarget);
#endif
            std::cout << "removed" << std::endl;
        } else return 2;
    } catch (const std::exception &) {
        std::cout << "rejected" << std::endl;
    }
    return 0;
}
