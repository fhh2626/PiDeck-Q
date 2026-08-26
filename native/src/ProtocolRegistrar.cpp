#include "ProtocolRegistrar.h"

#ifdef Q_OS_WIN
#include <windows.h>
#include <string>
#include <cwchar>
#endif

namespace {
#ifdef Q_OS_WIN
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
    if (RegCreateKeyExW(root, L"Software\\Classes\\pideck", 0, nullptr, 0,
                        KEY_WRITE, nullptr, &protocolKey, &protocolDisposition) != ERROR_SUCCESS) {
        return false;
    }
    const wchar_t *description = L"PiDeck-Q Agent Link";
    const LONG descriptionResult = RegSetValueExW(protocolKey, nullptr, 0, REG_SZ,
        reinterpret_cast<const BYTE *>(description),
        static_cast<DWORD>((wcslen(description) + 1) * sizeof(wchar_t)));
    const wchar_t *urlProtocol = L"";
    const LONG urlProtocolResult = RegSetValueExW(protocolKey, L"URL Protocol", 0, REG_SZ,
        reinterpret_cast<const BYTE *>(urlProtocol), sizeof(wchar_t));
    RegCloseKey(protocolKey);
    if (descriptionResult != ERROR_SUCCESS || urlProtocolResult != ERROR_SUCCESS) {
        if (protocolDisposition == REG_CREATED_NEW_KEY) RegDeleteTreeW(root, L"Software\\Classes\\pideck");
        return false;
    }

    HKEY commandKey = nullptr;
    DWORD commandDisposition = 0;
    if (RegCreateKeyExW(root, L"Software\\Classes\\pideck\\shell\\open\\command", 0,
                        nullptr, 0, KEY_WRITE, nullptr, &commandKey, &commandDisposition) != ERROR_SUCCESS) {
        if (protocolDisposition == REG_CREATED_NEW_KEY) RegDeleteTreeW(root, L"Software\\Classes\\pideck");
        return false;
    }
    const std::wstring commandWide = command.toStdWString();
    const LONG commandResult = RegSetValueExW(commandKey, nullptr, 0, REG_SZ,
        reinterpret_cast<const BYTE *>(commandWide.c_str()),
        static_cast<DWORD>((commandWide.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(commandKey);
    if (commandResult != ERROR_SUCCESS) {
        if (protocolDisposition == REG_CREATED_NEW_KEY || commandDisposition == REG_CREATED_NEW_KEY) {
            RegDeleteTreeW(root, L"Software\\Classes\\pideck");
        }
        return false;
    }
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
