; PiDeck-Q native installer. Qt WebView2 uses the machine/user Evergreen runtime;
; the installer never ships a Fixed Version WebView2 copy.
!include "LogicLib.nsh"
Unicode True
RequestExecutionLevel user
Name "PiDeck-Q"
OutFile "release\PiDeck-Q-Setup.exe"
InstallDir "$LOCALAPPDATA\PiDeck-Q"

!define WEBVIEW2_BOOTSTRAPPER_URL "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
!define PIDECK_APP_USER_MODEL_ID "com.ayuayue.pi-desktop"

Page directory
Page instfiles

Function .onInit
  ; WebView2 Evergreen Runtime registers a Client\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5} version under HKLM/HKCU.
  ; If absent, download/run Microsoft's signed Evergreen Bootstrapper silently.
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    InitPluginsDir
    inetc::get "${WEBVIEW2_BOOTSTRAPPER_URL}" "$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /END
    Pop $1
    ${If} $1 == "OK"
      ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install'
    ${Else}
      MessageBox MB_ICONSTOP "Microsoft Edge WebView2 Runtime is required to run PiDeck-Q."
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "PiDeck-Q"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "release\win-unpacked\*.*"

  ; Register the protocol at install time so pideck:// works before first launch.
  WriteRegStr HKCU "Software\Classes\pideck" "" "PiDeck-Q Agent Link"
  WriteRegStr HKCU "Software\Classes\pideck" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\pideck\shell\open\command" "" '"$INSTDIR\PiDeck-Q.exe" "%1"'

  ; WinRT toast activation requires a Start Menu shortcut with the matching
  ; System.AppUserModel.ID property. Apply it to both shortcuts we create.
  CreateDirectory "$SMPROGRAMS\PiDeck-Q"
  CreateShortCut "$SMPROGRAMS\PiDeck-Q\PiDeck-Q.lnk" "$INSTDIR\PiDeck-Q.exe" "" "$INSTDIR\PiDeck-Q.exe" 0
  CreateShortCut "$DESKTOP\PiDeck-Q.lnk" "$INSTDIR\PiDeck-Q.exe" "" "$INSTDIR\PiDeck-Q.exe" 0
  InitPluginsDir
  File /oname=$PLUGINSDIR\SetShortcutAppId.ps1 "installer\SetShortcutAppId.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\SetShortcutAppId.ps1" -Shortcut "$SMPROGRAMS\PiDeck-Q\PiDeck-Q.lnk" -AppId "${PIDECK_APP_USER_MODEL_ID}"'
  Pop $1
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\SetShortcutAppId.ps1" -Shortcut "$DESKTOP\PiDeck-Q.lnk" -AppId "${PIDECK_APP_USER_MODEL_ID}"'
  Pop $1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ; Do not remove another installed version's protocol association.
  ReadRegStr $0 HKCU "Software\Classes\pideck\shell\open\command" ""
  StrCpy $1 '"$INSTDIR\PiDeck-Q.exe" "%1"'
  ${If} $0 == $1
    DeleteRegKey HKCU "Software\Classes\pideck"
  ${EndIf}
  Delete "$SMPROGRAMS\PiDeck-Q\PiDeck-Q.lnk"
  RMDir "$SMPROGRAMS\PiDeck-Q"
  Delete "$DESKTOP\PiDeck-Q.lnk"
  RMDir /r "$INSTDIR"
SectionEnd
