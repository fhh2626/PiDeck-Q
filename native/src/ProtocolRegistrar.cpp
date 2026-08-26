#include "ProtocolRegistrar.h"

#ifdef Q_OS_WIN
#include <windows.h>
#include <string>
#include <vector>
#include <utility>
#include <cwchar>
#endif

namespace {
#ifdef Q_OS_WIN
constexpr wchar_t kProtocolKeyPath[] = L"Software\\Classes\\pideck";
constexpr wchar_t kCommandKeyPath[] = L"Software\\Classes\\pideck\\shell\\open\\command";

struct RegistryValueBackup {
    bool exists = false;
    DWORD type = REG_NONE;
    std::vector<BYTE> data;
};

LONG backupRegistryValue(HKEY key, const wchar_t *name, RegistryValueBackup &backup)
{
    backup = {};
    DWORD type = REG_NONE;
    DWORD bytes = 0;
    LONG result = RegQueryValueExW(key, name, nullptr, &type, nullptr, &bytes);
    if (result == ERROR_FILE_NOT_FOUND) return ERROR_SUCCESS;
    if (result != ERROR_SUCCESS) return result;

    std::vector<BYTE> data(bytes);
    DWORD dataBytes = bytes;
    result = RegQueryValueExW(key, name, nullptr, &type,
                              data.empty() ? nullptr : data.data(), &dataBytes);
    if (result != ERROR_SUCCESS) return result;
    data.resize(dataBytes);
    backup.exists = true;
    backup.type = type;
    backup.data = std::move(data);
    return ERROR_SUCCESS;
}

void restoreRegistryValue(HKEY key, const wchar_t *name, const RegistryValueBackup &backup)
{
    if (!backup.exists) {
        // Deleting a value that did not exist before is the inverse of our write.
        RegDeleteValueW(key, name);
        return;
    }
    RegSetValueExW(key, name, 0, backup.type,
                   backup.data.empty() ? nullptr : backup.data.data(),
                   static_cast<DWORD>(backup.data.size()));
}

void deleteCreatedKey(HKEY root, const wchar_t *path, DWORD disposition)
{
    if (disposition == REG_CREATED_NEW_KEY) RegDeleteTreeW(root, path);
}

QString protocolCommand(const QString &executablePath)
{
    return QStringLiteral("\"%1\" \"%2\"").arg(executablePath, "%1");
}
#endif
}

bool ProtocolRegistrar::registerProtocol(const QString &executablePath)
{
#ifdef Q_OS_WIN
    const QString command = protocolCommand(executablePath);
    HKEY root = HKEY_CURRENT_USER;
    HKEY protocolKey = nullptr;
    DWORD protocolDisposition = 0;
    if (RegCreateKeyExW(root, kProtocolKeyPath, 0, nullptr, 0,
                        KEY_READ | KEY_WRITE, nullptr, &protocolKey, &protocolDisposition) != ERROR_SUCCESS) {
        return false;
    }

    RegistryValueBackup descriptionBackup;
    RegistryValueBackup urlProtocolBackup;
    if (backupRegistryValue(protocolKey, nullptr, descriptionBackup) != ERROR_SUCCESS
        || backupRegistryValue(protocolKey, L"URL Protocol", urlProtocolBackup) != ERROR_SUCCESS) {
        RegCloseKey(protocolKey);
        deleteCreatedKey(root, kProtocolKeyPath, protocolDisposition);
        return false;
    }

    const auto rollbackProtocolValues = [&]() {
        restoreRegistryValue(protocolKey, nullptr, descriptionBackup);
        restoreRegistryValue(protocolKey, L"URL Protocol", urlProtocolBackup);
        RegCloseKey(protocolKey);
        deleteCreatedKey(root, kProtocolKeyPath, protocolDisposition);
    };

    const wchar_t *description = L"PiDeck-Q Agent Link";
    const LONG descriptionResult = RegSetValueExW(protocolKey, nullptr, 0, REG_SZ,
        reinterpret_cast<const BYTE *>(description),
        static_cast<DWORD>((wcslen(description) + 1) * sizeof(wchar_t)));
    const wchar_t *urlProtocol = L"";
    const LONG urlProtocolResult = RegSetValueExW(protocolKey, L"URL Protocol", 0, REG_SZ,
        reinterpret_cast<const BYTE *>(urlProtocol), sizeof(wchar_t));
    if (descriptionResult != ERROR_SUCCESS || urlProtocolResult != ERROR_SUCCESS) {
        rollbackProtocolValues();
        return false;
    }

    HKEY commandKey = nullptr;
    DWORD commandDisposition = 0;
    if (RegCreateKeyExW(root, kCommandKeyPath, 0, nullptr, 0,
                        KEY_READ | KEY_WRITE, nullptr, &commandKey, &commandDisposition) != ERROR_SUCCESS) {
        rollbackProtocolValues();
        return false;
    }

    RegistryValueBackup commandBackup;
    if (backupRegistryValue(commandKey, nullptr, commandBackup) != ERROR_SUCCESS) {
        RegCloseKey(commandKey);
        deleteCreatedKey(root, kCommandKeyPath, commandDisposition);
        rollbackProtocolValues();
        return false;
    }

    const std::wstring commandWide = command.toStdWString();
    const LONG commandResult = RegSetValueExW(commandKey, nullptr, 0, REG_SZ,
        reinterpret_cast<const BYTE *>(commandWide.c_str()),
        static_cast<DWORD>((commandWide.size() + 1) * sizeof(wchar_t)));
    if (commandResult != ERROR_SUCCESS) {
        restoreRegistryValue(commandKey, nullptr, commandBackup);
        RegCloseKey(commandKey);
        // Do not remove an existing command tree when only this registration
        // attempt created the leaf key.
        deleteCreatedKey(root, kCommandKeyPath, commandDisposition);
        rollbackProtocolValues();
        return false;
    }

    RegCloseKey(commandKey);
    RegCloseKey(protocolKey);
    return true;
#else
    Q_UNUSED(executablePath);
    return false;
#endif
}

bool ProtocolRegistrar::unregisterProtocol(const QString &executablePath)
{
#ifdef Q_OS_WIN
    HKEY commandKey = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER,
                      L"Software\\Classes\\pideck\\shell\\open\\command",
                      0, KEY_READ, &commandKey) != ERROR_SUCCESS) {
        return true;
    }
    wchar_t value[4096]{};
    DWORD valueBytes = sizeof(value);
    DWORD type = 0;
    const LONG result = RegQueryValueExW(commandKey, nullptr, nullptr, &type,
                                          reinterpret_cast<BYTE *>(value), &valueBytes);
    RegCloseKey(commandKey);
    if (result != ERROR_SUCCESS || type != REG_SZ) return false;

    const QString current = QString::fromWCharArray(value);
    if (current != protocolCommand(executablePath)) return false;
    return RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\pideck") == ERROR_SUCCESS;
#else
    Q_UNUSED(executablePath);
    return false;
#endif
}
