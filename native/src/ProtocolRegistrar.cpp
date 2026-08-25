#include "ProtocolRegistrar.h"

#ifdef Q_OS_WIN
#include <windows.h>
#include <string>
#include <cwchar>
#endif

bool ProtocolRegistrar::registerProtocol(const QString &executablePath)
{
#ifdef Q_OS_WIN
    const QString command = QStringLiteral("\"%1\" \"%2\"").arg(executablePath, "%1");
    HKEY root = HKEY_CURRENT_USER;
    HKEY protocolKey = nullptr;
    DWORD disposition = 0;
    if (RegCreateKeyExW(root, L"Software\\Classes\\pideck", 0, nullptr, 0,
                        KEY_WRITE, nullptr, &protocolKey, &disposition) != ERROR_SUCCESS) {
        return false;
    }
    const wchar_t *description = L"PiDeck-Q Agent Link";
    RegSetValueExW(protocolKey, nullptr, 0, REG_SZ,
                   reinterpret_cast<const BYTE *>(description),
                   static_cast<DWORD>((wcslen(description) + 1) * sizeof(wchar_t)));
    const wchar_t *urlProtocol = L"";
    RegSetValueExW(protocolKey, L"URL Protocol", 0, REG_SZ,
                   reinterpret_cast<const BYTE *>(urlProtocol), sizeof(wchar_t));
    RegCloseKey(protocolKey);

    HKEY commandKey = nullptr;
    if (RegCreateKeyExW(root, L"Software\\Classes\\pideck\\shell\\open\\command", 0,
                        nullptr, 0, KEY_WRITE, nullptr, &commandKey, &disposition) != ERROR_SUCCESS) {
        return false;
    }
    const std::wstring commandWide = command.toStdWString();
    RegSetValueExW(commandKey, nullptr, 0, REG_SZ,
                   reinterpret_cast<const BYTE *>(commandWide.c_str()),
                   static_cast<DWORD>((commandWide.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(commandKey);
    return true;
#else
    Q_UNUSED(executablePath);
    return false;
#endif
}
